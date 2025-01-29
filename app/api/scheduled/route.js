import { NextResponse } from "next/server";
import initStripe from "stripe";
import nodemailer from "nodemailer";
import { PDFDocument } from "pdf-lib";
import axios from "axios";
import axiosRateLimit from "axios-rate-limit";

/**
 * Because we no longer use config.json, we load our Stripe keys
 * from environment variables. We'll store them in an object:
 */
const STRIPE_KEYS = {
  PC: process.env.STRIPE_PC,
  ET: process.env.STRIPE_ET,
  PCP: process.env.STRIPE_PCP,
};

// 1) Download PDF in memory. We DO NOT throw if it fails all attempts.
//    Instead, return null so we can skip it gracefully.
async function downloadPdfInMemory(url, invoiceNumber, http) {
  let attempt = 1;
  const maxAttempts = 5;

  while (attempt <= maxAttempts) {
    try {
      if (!url) {
        console.error(`No PDF URL for invoice ${invoiceNumber}`);
        return null;
      }
      const response = await http.get(url, { responseType: "arraybuffer" });
      console.log(`File downloaded in memory for invoice: ${invoiceNumber}`);
      return response.data; // PDF buffer
    } catch (error) {
      console.error(`Error downloading ${invoiceNumber} (attempt ${attempt}):`, error);
      if (attempt === maxAttempts) {
        console.error(`Skipping invoice ${invoiceNumber} after max attempts`);
        return null;
      }
    }
    attempt++;
  }

  return null; // Should never reach here, but just in case.
}

// 2) Merge PDF buffers in memory
async function mergePdfs(pdfBuffers) {
  try {
    const mergedPdf = await PDFDocument.create();
    for (const buffer of pdfBuffers) {
      if (!buffer) continue; // skip null or invalid
      const tempPdf = await PDFDocument.load(buffer);
      const copiedPages = await mergedPdf.copyPages(
        tempPdf,
        tempPdf.getPageIndices()
      );
      copiedPages.forEach((page) => mergedPdf.addPage(page));
    }
    return await mergedPdf.save(); // returns a Uint8Array (Buffer)
  } catch (err) {
    console.error("Error merging PDF buffers:", err);
    return null; // Return null if there's a merge failure
  }
}

// 3) Create an empty PDF
async function createEmptyPdf() {
  try {
    const pdfDoc = await PDFDocument.create();
    const page = pdfDoc.addPage();
    page.drawText("No data available for this category.");
    return await pdfDoc.save();
  } catch (err) {
    console.error("Error creating empty PDF:", err);
    return null;
  }
}

// 4) Fetch invoices from Stripe, or return empty arrays if error
async function getInvoices(stripe, gte, lte) {
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

      invoices.data.forEach((invoice) => {
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
        console.log(`Invoice ID: ${invoice.id}`);
        console.log("---------------------------");
      });

      if (!invoices.has_more) break;
      starting_after = invoices.data[invoices.data.length - 1].id;
    }
  } catch (error) {
    console.error("Error fetching invoices from Stripe:", error);
    // Return empty arrays so we skip gracefully
    return { paidAndOpenLinks: [], otherStatusLinks: [] };
  }

  return { paidAndOpenLinks, otherStatusLinks };
}

/**
 * Next.js route configuration. We want Node.js runtime for nodemailer.
 * Also, we set up default export so that Vercel can run it as a scheduled job.
 */
export const config = {
  runtime: "nodejs",
};

// GET can respond with a helpful message (or do nothing).
export async function GET() {
  return NextResponse.json({
    message: "This route is triggered automatically on the 2nd of each month via Vercel Cron.",
  });
}

/**
 * By default, scheduled functions use the GET method on Vercel.
 * We'll implement a default export to handle that.
 * If you want to use a custom method or verify the docs, see:
 * https://vercel.com/docs/scheduled-functions
 */
export default async function handler() {
  console.log("===== Starting monthly PDF email job =====");

  // 1) Determine last month from today's date
  const now = new Date(); // e.g., 2025-02-02
  const currentMonth = now.getMonth(); // 0-based
  const currentYear = now.getFullYear();

  // "lastMonthDate" is the 1st day of the previous month
  const lastMonthDate = new Date(currentYear, currentMonth - 1, 1);
  const lastMonthYear = lastMonthDate.getFullYear();
  const lastMonthIndex = lastMonthDate.getMonth(); // 0-based

  console.log("Now:", now.toISOString());
  console.log("Last Month Date:", lastMonthDate.toISOString());

  // Build start/end date range for last month
  const startDate = new Date(lastMonthYear, lastMonthIndex, 1);
  const endDate = new Date(lastMonthYear, lastMonthIndex + 1, 0);
  endDate.setHours(23, 59, 59, 999);

  console.log("Start date:", startDate.toISOString());
  console.log("End date:", endDate.toISOString());

  const gte = Math.floor(startDate.getTime() / 1000);
  const lte = Math.floor(endDate.getTime() / 1000);

  // For naming final PDFs
  const monthNames = [
    "January", "February", "March", "April", "May",
    "June", "July", "August", "September", "October",
    "November", "December"
  ];
  const monthName = monthNames[lastMonthIndex];

  // Setup axios with rate limiting
  const http = axiosRateLimit(axios.create(), { maxRPS: 80 });

  // We'll gather two sets of attachments (ET vs. PC/PCP)
  const attachmentsET = [];
  const attachmentsNonET = [];

  // 2) For each Stripe key...
  for (const configKey of Object.keys(STRIPE_KEYS)) {
    const keyVal = STRIPE_KEYS[configKey];
    if (!keyVal) {
      console.error(`Missing environment variable for ${configKey}, skipping...`);
      continue;
    }

    let paidAndOpenLinks = [];
    let otherStatusLinks = [];

    try {
      const stripe = initStripe(keyVal);
      // Fetch the invoices
      const result = await getInvoices(stripe, gte, lte);
      paidAndOpenLinks = result.paidAndOpenLinks;
      otherStatusLinks = result.otherStatusLinks;
    } catch (err) {
      console.error(`Error initializing Stripe or retrieving data for ${configKey}:`, err);
      // Skip this key
      continue;
    }

    // Now we handle 2 categories
    const categories = [
      { name: "Paid_And_Open", links: paidAndOpenLinks },
      { name: "Other_Status", links: otherStatusLinks },
    ];

    for (const cat of categories) {
      let finalPdfBuffer = null;

      if (cat.links.length > 0) {
        // Attempt to download each invoice's PDF
        const pdfBuffers = [];
        for (const invoice of cat.links) {
          try {
            const buff = await downloadPdfInMemory(
              invoice.invoice_pdf,
              invoice.invoice_number,
              http
            );
            if (buff) pdfBuffers.push(buff);
          } catch (err) {
            console.error(`Error downloading invoice ${invoice.invoice_number}:`, err);
            // Skip this invoice
          }
        }

        // Merge them (may return null if error)
        finalPdfBuffer = await mergePdfs(pdfBuffers);
        if (!finalPdfBuffer) {
          console.warn(`Merging failed or empty for ${configKey}-${cat.name}, creating fallback PDF...`);
          finalPdfBuffer = await createEmptyPdf();
        }
      } else {
        // If no links, create an empty PDF
        finalPdfBuffer = await createEmptyPdf();
      }

      if (!finalPdfBuffer) {
        console.error(`Could not create final PDF for ${configKey}-${cat.name}, skipping attachment...`);
        continue;
      }

      // Decide which array to push to
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

  // 3) Email them out
  const adminEmail = process.env.ADMIN_EMAIL;
  const gmailAppPassword = process.env.GMAIL_APP_PASSWORD;

  if (!adminEmail || !gmailAppPassword) {
    console.error("Missing Gmail credentials. Please set ADMIN_EMAIL & GMAIL_APP_PASSWORD.");
    // We'll just end here, but return success = false if you prefer
    return NextResponse.json({ success: false, message: "Missing email credentials" }, { status: 200 });
  }

  // Create the Nodemailer transporter
  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: adminEmail,
      pass: gmailAppPassword,
    },
  });

  // 4) Send ET attachments to one email
  if (attachmentsET.length > 0) {
    try {
      await transporter.sendMail({
        from: adminEmail,
        to: "mumair299792458u@gmail.com",
        subject: `PDF Invoices for ${monthName} ${lastMonthYear} (ET)`,
        text: `Attached are the combined PDF invoices (ET) for ${monthName}, ${lastMonthYear}.`,
        attachments: attachmentsET,
      });
      console.log("ET email sent successfully.");
    } catch (err) {
      console.error("Error sending ET email:", err);
    }
  } else {
    console.log("No ET attachments to send.");
  }

  // 5) Send PC & PCP attachments to second email
  if (attachmentsNonET.length > 0) {
    try {
      await transporter.sendMail({
        from: adminEmail,
        to: "uzairshabbirsab@gmail.com",
        subject: `PDF Invoices for ${monthName} ${lastMonthYear} (PC & PCP)`,
        text: `Attached are the combined PDF invoices (PC & PCP) for ${monthName}, ${lastMonthYear}.`,
        attachments: attachmentsNonET,
      });
      console.log("PC & PCP email sent successfully.");
    } catch (err) {
      console.error("Error sending PC/PCP email:", err);
    }
  } else {
    console.log("No PC/PCP attachments to send.");
  }

  console.log("===== Monthly PDF email job completed. =====");
  // We always return success, even if partial failures occurred, per your request.
  return NextResponse.json({ success: true }, { status: 200 });
}
