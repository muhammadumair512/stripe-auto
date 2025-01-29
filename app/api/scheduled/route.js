import { NextResponse } from "next/server";
import initStripe from "stripe";
import nodemailer from "nodemailer";
import { PDFDocument } from "pdf-lib";
import axios from "axios";
import axiosRateLimit from "axios-rate-limit";

export const config = {
  // Force Node.js runtime for nodemailer, etc.
  runtime: "nodejs",
};

/** 
 * Environment variables:
 *   STRIPE_PC, STRIPE_ET, STRIPE_PCP
 *   ADMIN_EMAIL, GMAIL_APP_PASSWORD
 */
const STRIPE_KEYS = {
  PC: process.env.STRIPE_PC,
  ET: process.env.STRIPE_ET,
  PCP: process.env.STRIPE_PCP,
};

// Helper to log both to console and to a "logs" array
function pushLog(logs, message) {
  console.log(message);
  logs.push(message);
}

/**
 * Download a single PDF in memory. 
 * If it fails after max attempts, returns null (skips).
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
      pushLog(
        logs,
        `Error downloading ${invoiceNumber} (attempt ${attempt}): ${error}`
      );
      if (attempt === maxAttempts) {
        pushLog(logs, `Skipping invoice ${invoiceNumber} after max attempts`);
        return null;
      }
    }
    attempt++;
  }
  return null; // Should never reach here, fallback
}

/** Merge PDF buffers in memory. Returns null on failure. */
async function mergePdfs(pdfBuffers, logs) {
  try {
    const mergedPdf = await PDFDocument.create();
    for (const buffer of pdfBuffers) {
      if (!buffer) continue;
      const tempPdf = await PDFDocument.load(buffer);
      const copiedPages = await mergedPdf.copyPages(
        tempPdf,
        tempPdf.getPageIndices()
      );
      copiedPages.forEach((page) => mergedPdf.addPage(page));
    }
    return await mergedPdf.save(); // returns a Uint8Array
  } catch (err) {
    pushLog(logs, `Error merging PDF buffers: ${err}`);
    return null;
  }
}

/** Create an empty PDF that says "No data available..." */
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

/** Fetch invoices from Stripe, or return empty arrays if error. */
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
        pushLog(logs, `Invoice ID: ${invoice.id}`);
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

/** 
 * Our main function to:
 *  1) Calculate the previous complete month
 *  2) Fetch & merge PDFs from Stripe
 *  3) Email them to different recipients
 *  4) Return a NextResponse with logs
 */
async function runMonthlyJob() {
  const logs = [];

  pushLog(logs, "===== Starting monthly PDF email job =====");

  // 1) Determine last month from today's date
  const now = new Date();
  pushLog(logs, `Now: ${now.toISOString()}`);

  const currentMonth = now.getMonth(); // 0-based
  const currentYear = now.getFullYear();

  // "lastMonthDate" is the 1st day of the previous month
  const lastMonthDate = new Date(currentYear, currentMonth - 1, 1);
  pushLog(logs, `Last Month Date: ${lastMonthDate.toISOString()}`);

  const lastMonthYear = lastMonthDate.getFullYear();
  const lastMonthIndex = lastMonthDate.getMonth();

  // Build start/end date range for last month
  const startDate = new Date(lastMonthYear, lastMonthIndex, 1);
  const endDate = new Date(lastMonthYear, lastMonthIndex + 1, 0);
  endDate.setHours(23, 59, 59, 999);

  pushLog(logs, `Start date: ${startDate.toISOString()}`);
  pushLog(logs, `End date: ${endDate.toISOString()}`);

  const gte = Math.floor(startDate.getTime() / 1000);
  const lte = Math.floor(endDate.getTime() / 1000);

  const monthNames = [
    "January","February","March","April","May","June",
    "July","August","September","October","November","December"
  ];
  const monthName = monthNames[lastMonthIndex];

  // 2) Rate-limited axios
  const http = axiosRateLimit(axios.create(), { maxRPS: 80 });

  // We'll gather two sets of attachments (ET vs. PC/PCP)
  const attachmentsET = [];
  const attachmentsNonET = [];

  // 3) For each Stripe key
  for (const configKey of Object.keys(STRIPE_KEYS)) {
    const keyVal = STRIPE_KEYS[configKey];
    if (!keyVal) {
      pushLog(logs, `Missing environment variable for ${configKey}, skipping...`);
      continue;
    }

    let paidAndOpenLinks = [];
    let otherStatusLinks = [];

    try {
      const stripe = initStripe(keyVal);
      const result = await getInvoices(stripe, gte, lte, logs);
      paidAndOpenLinks = result.paidAndOpenLinks;
      otherStatusLinks = result.otherStatusLinks;
    } catch (err) {
      pushLog(logs, `Error initializing Stripe or retrieving data for ${configKey}: ${err}`);
      continue; // skip this key
    }

    // Categories
    const categories = [
      { name: "Paid_And_Open", links: paidAndOpenLinks },
      { name: "Other_Status", links: otherStatusLinks },
    ];

    for (const cat of categories) {
      let finalPdfBuffer = null;

      if (cat.links.length > 0) {
        const pdfBuffers = [];
        for (const invoice of cat.links) {
          try {
            const buff = await downloadPdfInMemory(
              invoice.invoice_pdf,
              invoice.invoice_number,
              http,
              logs
            );
            if (buff) pdfBuffers.push(buff);
          } catch (err) {
            pushLog(logs, `Error downloading invoice ${invoice.invoice_number}: ${err}`);
          }
        }
        // Merge them
        finalPdfBuffer = await mergePdfs(pdfBuffers, logs);
        if (!finalPdfBuffer) {
          pushLog(logs, `Merging failed or empty for ${configKey}-${cat.name}, creating fallback PDF...`);
          finalPdfBuffer = await createEmptyPdf(logs);
        }
      } else {
        // No links, create empty
        finalPdfBuffer = await createEmptyPdf(logs);
      }

      if (!finalPdfBuffer) {
        pushLog(logs, `Could not create final PDF for ${configKey}-${cat.name}, skipping attachment...`);
        continue;
      }

      const attachment = {
        filename: `${configKey.toUpperCase()}-${cat.name}-${monthName}-${lastMonthYear}.pdf`,
        content: Buffer.from(finalPdfBuffer),
      };

      if (configKey === "ET") {
        attachmentsET.push(attachment);
      } else {
        attachmentsNonET.push(attachment);
      }
    }
  }

  // 4) Email them out
  const adminEmail = process.env.ADMIN_EMAIL;
  const gmailAppPassword = process.env.GMAIL_APP_PASSWORD;

  if (!adminEmail || !gmailAppPassword) {
    pushLog(logs, "Missing Gmail credentials. Please set ADMIN_EMAIL & GMAIL_APP_PASSWORD.");
    return {
      success: false,
      logs,
      month: monthName,
      year: lastMonthYear,
      message: "Missing email credentials",
    };
  }

  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: adminEmail,
      pass: gmailAppPassword,
    },
  });

  // ET → mumair299792458u@gmail.com
  if (attachmentsET.length > 0) {
    try {
      await transporter.sendMail({
        from: adminEmail,
        to: "mumair299792458u@gmail.com",
        subject: `PDF Invoices for ${monthName} ${lastMonthYear} (ET)`,
        text: `Attached are the combined PDF invoices (ET) for ${monthName}, ${lastMonthYear}.`,
        attachments: attachmentsET,
      });
      pushLog(logs, "ET email sent successfully.");
    } catch (err) {
      pushLog(logs, `Error sending ET email: ${err}`);
    }
  } else {
    pushLog(logs, "No ET attachments to send.");
  }

  // PC & PCP → uzairshabbirsab@gmail.com
  if (attachmentsNonET.length > 0) {
    try {
      await transporter.sendMail({
        from: adminEmail,
        to: "uzairshabbirsab@gmail.com",
        subject: `PDF Invoices for ${monthName} ${lastMonthYear} (PC & PCP)`,
        text: `Attached are the combined PDF invoices (PC & PCP) for ${monthName}, ${lastMonthYear}.`,
        attachments: attachmentsNonET,
      });
      pushLog(logs, "PC & PCP email sent successfully.");
    } catch (err) {
      pushLog(logs, `Error sending PC/PCP email: ${err}`);
    }
  } else {
    pushLog(logs, "No PC/PCP attachments to send.");
  }

  pushLog(logs, "===== Monthly PDF email job completed. =====");
  return {
    success: true,
    logs,
    month: monthName,
    year: lastMonthYear,
  };
}

/**
 * GET request handler:
 *   1) Runs the job to fetch & merge last month's invoices
 *   2) Returns JSON with success/failure, logs, and which month/year was processed.
 */
export async function GET() {
  try {
    const result = await runMonthlyJob();
    // Return the result as JSON
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    console.error("Top-level error in monthly job:", err);
    return NextResponse.json(
      { success: false, message: err.message },
      { status: 500 }
    );
  }
}

/**
 * We also export a default function for older Vercel "scheduled" usage,
 * but in practice, the GET above is what you call.
 */
export default async function handler() {
  // The same logic if your route is triggered by a scheduled call
  try {
    const result = await runMonthlyJob();
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    console.error("Top-level error in monthly job (default):", err);
    return NextResponse.json(
      { success: false, message: err.message },
      { status: 500 }
    );
  }
}
