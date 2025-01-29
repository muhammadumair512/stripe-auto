import { NextResponse } from "next/server";
import initStripe from "stripe";
import nodemailer from "nodemailer";
import { PDFDocument } from "pdf-lib";
import axios from "axios";
import axiosRateLimit from "axios-rate-limit";

export const config = {
  // Force Node.js runtime (needed for nodemailer, etc.)
  runtime: "nodejs",
};

/** Environment variables (set them in .env.local / Vercel Env):
 *   STRIPE_PC, STRIPE_ET, STRIPE_PCP
 *   ADMIN_EMAIL, GMAIL_APP_PASSWORD
 */
const STRIPE_KEYS = {
  PC: process.env.STRIPE_PC,
  ET: process.env.STRIPE_ET,
  PCP: process.env.STRIPE_PCP,
};

// A helper function to push logs to an array & also console.log
function pushLog(logs, msg) {
  console.log(msg);
  logs.push(msg);
}

/**
 * Download a single PDF in memory. If it fails after max attempts,
 * returns null (skips that invoice).
 */
async function downloadPdfInMemory(url, invoiceNumber, http, logs) {
  let attempt = 1;
  const maxAttempts = 5;

  while (attempt <= maxAttempts) {
    try {
      if (!url) {
        pushLog(logs, `No PDF URL for invoice ${invoiceNumber}`);
        return null;
      }
      const response = await http.get(url, { responseType: "arraybuffer" });
      pushLog(logs, `File downloaded in memory for invoice: ${invoiceNumber}`);
      return response.data; // PDF buffer
    } catch (error) {
      pushLog(logs, `Error downloading ${invoiceNumber} (attempt ${attempt}): ${error}`);
      if (attempt === maxAttempts) {
        pushLog(logs, `Skipping invoice ${invoiceNumber} after max attempts`);
        return null;
      }
    }
    attempt++;
  }
  return null; // theoretically never gets here
}

/** Merge PDF buffers in memory. Returns null on failure. */
async function mergePdfs(pdfBuffers, logs) {
  try {
    const mergedPdf = await PDFDocument.create();
    for (const buffer of pdfBuffers) {
      if (!buffer) continue; // skip any null
      const tempPdf = await PDFDocument.load(buffer);
      const copiedPages = await mergedPdf.copyPages(tempPdf, tempPdf.getPageIndices());
      copiedPages.forEach((page) => mergedPdf.addPage(page));
    }
    return await mergedPdf.save(); // returns Uint8Array
  } catch (err) {
    pushLog(logs, `Error merging PDF buffers: ${err}`);
    return null;
  }
}

/** Create an empty PDF with "No data available for this category." text */
async function createEmptyPdf(logs) {
  try {
    const pdfDoc = await PDFDocument.create();
    const page = pdfDoc.addPage();
    page.drawText("No data available for this category.");
    return await pdfDoc.save();
  } catch (err) {
    pushLog(logs, `Error creating empty PDF: ${err}`);
    return null;
  }
}

/** Fetch invoices from Stripe in [gte, lte], skipping if errors. */
async function getInvoices(stripe, gte, lte, logs) {
  const paidAndOpenLinks = [];
  const otherStatusLinks = [];

  try {
    let starting_after;
    while (true) {
      const invoices = await stripe.invoices.list({
        limit: 10,
        starting_after,
        created: { gte, lte },
      });

      if (!invoices.data || invoices.data.length === 0) {
        break;
      }

      for (const invoice of invoices.data) {
        const pdfLink = {
          invoice_pdf: invoice.invoice_pdf,
          invoice_number: invoice.number,
          amount_paid: invoice.amount_paid,
          amount_due: invoice.amount_due,
        };

        if (["paid", "open"].includes(invoice.status)) {
          paidAndOpenLinks.push(pdfLink);
        } else {
          otherStatusLinks.push(pdfLink);
        }

        pushLog(logs, `Invoice ID: ${invoice.id} (num: ${invoice.number})`);
      }

      if (!invoices.has_more) break;
      starting_after = invoices.data[invoices.data.length - 1].id;
    }
  } catch (error) {
    pushLog(logs, `Error fetching invoices from Stripe: ${error}`);
    return { paidAndOpenLinks: [], otherStatusLinks: [] };
  }

  return { paidAndOpenLinks, otherStatusLinks };
}

/** Format a date as e.g. "2025-01-28" for logs/emails */
function formatDate(dateObj) {
  // Adjust as needed for your preferred format
  const yyyy = dateObj.getFullYear();
  const mm = String(dateObj.getMonth() + 1).padStart(2, "0");
  const dd = String(dateObj.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * The main function to:
 *  1) Calculate date range: "today - 1 month" to "yesterday"
 *  2) Fetch & merge PDFs
 *  3) Email them out
 *  4) Return logs + success/fail
 */
async function runMonthlyJob() {
  const logs = [];
  pushLog(logs, "===== Starting PDF invoice job =====");

  const now = new Date();
  pushLog(logs, `Now: ${now.toISOString()}`);

  // startDate = "today minus 1 month, same day-of-month"
  // endDate   = "yesterday"
  const startDate = new Date(now);
  startDate.setMonth(startDate.getMonth() - 1); // e.g. if today is Jan 29 => Dec 29
  startDate.setHours(0, 0, 0, 0);

  const endDate = new Date(now);
  endDate.setDate(endDate.getDate() - 1); // e.g. if today is Jan 29 => Jan 28
  endDate.setHours(23, 59, 59, 999);

  pushLog(logs, `Range Start: ${startDate.toISOString()}`);
  pushLog(logs, `Range End:   ${endDate.toISOString()}`);

  const gte = Math.floor(startDate.getTime() / 1000);
  const lte = Math.floor(endDate.getTime() / 1000);

  // We'll keep attachments for ET vs. PC/PCP
  const attachmentsET = [];
  const attachmentsNonET = [];

  // Rate-limited axios
  const http = axiosRateLimit(axios.create(), { maxRPS: 80 });

  // For each Stripe environment key
  for (const configKey of Object.keys(STRIPE_KEYS)) {
    const stripeKey = STRIPE_KEYS[configKey];
    if (!stripeKey) {
      pushLog(logs, `Missing env var for ${configKey}, skipping`);
      continue;
    }

    let paidAndOpenLinks = [];
    let otherStatusLinks = [];

    try {
      const stripe = initStripe(stripeKey);
      const result = await getInvoices(stripe, gte, lte, logs);
      paidAndOpenLinks = result.paidAndOpenLinks;
      otherStatusLinks = result.otherStatusLinks;
    } catch (err) {
      pushLog(logs, `Error with Stripe for ${configKey}: ${err}`);
      continue;
    }

    // 2 categories: "Paid_And_Open", "Other_Status"
    const categories = [
      { name: "Paid_And_Open", links: paidAndOpenLinks },
      { name: "Other_Status", links: otherStatusLinks },
    ];

    for (const cat of categories) {
      let finalPdfBuffer;

      if (cat.links.length > 0) {
        // Download each invoice
        const pdfBuffers = [];
        for (const invoice of cat.links) {
          const buffer = await downloadPdfInMemory(
            invoice.invoice_pdf,
            invoice.invoice_number,
            http,
            logs
          );
          if (buffer) pdfBuffers.push(buffer);
        }

        // Merge
        if (pdfBuffers.length > 0) {
          finalPdfBuffer = await mergePdfs(pdfBuffers, logs);
        } else {
          pushLog(logs, `No valid PDFs for ${configKey}-${cat.name}, creating empty PDF`);
          finalPdfBuffer = await createEmptyPdf(logs);
        }
      } else {
        // No invoices => empty PDF
        finalPdfBuffer = await createEmptyPdf(logs);
      }

      if (!finalPdfBuffer) {
        pushLog(logs, `Could not create final PDF for ${configKey}-${cat.name}, skipping`);
        continue;
      }

      const fileName = `${configKey.toUpperCase()}-${cat.name}-${formatDate(startDate)}_to_${formatDate(endDate)}.pdf`;
      const attachment = {
        filename: fileName,
        content: Buffer.from(finalPdfBuffer),
      };

      if (configKey === "ET") {
        attachmentsET.push(attachment);
      } else {
        attachmentsNonET.push(attachment);
      }
    }
  }

  // Now email them out
  const adminEmail = process.env.ADMIN_EMAIL;
  const gmailAppPassword = process.env.GMAIL_APP_PASSWORD;

  if (!adminEmail || !gmailAppPassword) {
    pushLog(logs, "Missing email credentials. Not sending anything.");
    return { success: false, logs, message: "Missing email credentials" };
  }

  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: adminEmail,
      pass: gmailAppPassword,
    },
  });

  // ET => mumair299792458u@gmail.com
  if (attachmentsET.length > 0) {
    try {
      await transporter.sendMail({
        from: adminEmail,
        to: "mumair299792458u@gmail.com",
        // to: "accounts@esteponatyres.es",
        subject: `PDF Invoices for ${formatDate(startDate)} to ${formatDate(endDate)} (ET)`,
        text: `Attached are the combined PDF invoices (ET) covering ${formatDate(startDate)} through ${formatDate(endDate)}.`,
        attachments: attachmentsET,
      });
      pushLog(logs, "ET email sent successfully.");
    } catch (err) {
      pushLog(logs, `Error sending ET email: ${err}`);
    }
  } else {
    pushLog(logs, "No ET attachments to send.");
  }

  // PC & PCP => uzairshabbirsab@gmail.com
  if (attachmentsNonET.length > 0) {
    try {
      await transporter.sendMail({
        from: adminEmail,
        to: "mumair299792458u@gmail.com",
        // to: "accounts@purplegroup.es",
        subject: `PDF Invoices for ${formatDate(startDate)} to ${formatDate(endDate)} (PC & PCP)`,
        text: `Attached are the combined PDF invoices (PC & PCP) covering ${formatDate(startDate)} through ${formatDate(endDate)}.`,
        attachments: attachmentsNonET,
      });
      pushLog(logs, "PC & PCP email sent successfully.");
    } catch (err) {
      pushLog(logs, `Error sending PC/PCP email: ${err}`);
    }
  } else {
    pushLog(logs, "No PC/PCP attachments to send.");
  }

  pushLog(logs, "===== Invoice job completed. =====");
  return { success: true, logs };
}

/** GET: fetch/merge last-month invoices, return JSON with logs. */
export async function GET() {
  try {
    const result = await runMonthlyJob();
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    console.error("Top-level error in monthly job:", err);
    return NextResponse.json({ success: false, message: err.message }, { status: 500 });
  }
}

/** default: same logic if triggered by some scheduling */
export default async function handler() {
  try {
    const result = await runMonthlyJob();
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    console.error("Top-level error in monthly job (default):", err);
    return NextResponse.json({ success: false, message: err.message }, { status: 500 });
  }
}
