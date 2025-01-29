// app/api/generateAndEmail/route.js  (example path; adjust to your own Next.js project)

import { NextResponse } from "next/server";
import initStripe from "stripe";
import nodemailer from "nodemailer";
import { PDFDocument } from "pdf-lib";
import axios from "axios";
import axiosRateLimit from "axios-rate-limit";

/** 
 * Instead of config.json, we use environment variables for Stripe keys.
 * e.g. in .env.local (and Vercel dashboard):
 *   STRIPE_PC=sk_test_...
 *   STRIPE_ET=sk_test_...
 *   STRIPE_PCP=sk_test_...
 */
const STRIPE_KEYS = {
  PC: process.env.STRIPE_PC,
  ET: process.env.STRIPE_ET,
  PCP: process.env.STRIPE_PCP,
};

// 1) Download PDF in memory, skipping if fails after max attempts
async function downloadPdfInMemory(url, invoiceNumber, http) {
  let attempt = 1;
  const maxAttempts = 5;

  while (attempt <= maxAttempts) {
    try {
      if (!url) {
        // Gracefully skip (no valid URL)
        console.error(`Skipping invoice ${invoiceNumber}: Missing PDF URL.`);
        return null;
      }
      const response = await http.get(url, { responseType: "arraybuffer" });
      console.log(`File downloaded in memory for invoice: ${invoiceNumber}`);
      return response.data; // PDF buffer
    } catch (error) {
      console.error(`Error downloading ${invoiceNumber} (attempt ${attempt}):`, error);
      if (attempt === maxAttempts) {
        // If we've reached max attempts, skip this invoice
        console.error(`Skipping invoice ${invoiceNumber} after max attempts`);
        return null;
      }
      console.log(`Retrying download of ${invoiceNumber} (attempt ${attempt})`);
    }
    attempt++;
  }
  return null; // fallback, theoretically never hit
}

// 2) Merge PDF buffers in memory
async function mergePdfs(pdfBuffers) {
  const mergedPdf = await PDFDocument.create();

  for (const buffer of pdfBuffers) {
    if (!buffer) continue; // skip null / failed downloads
    const tempPdf = await PDFDocument.load(buffer);
    const copiedPages = await mergedPdf.copyPages(tempPdf, tempPdf.getPageIndices());
    copiedPages.forEach((page) => mergedPdf.addPage(page));
  }

  return await mergedPdf.save(); // returns a Uint8Array
}

// 3) Create an empty PDF if no invoices or errors
async function createEmptyPdf() {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage();
  page.drawText("No data available for this category.");
  return await pdfDoc.save();
}

// 4) Fetch invoices from Stripe for the given time range
async function getInvoices(stripe, gte, lte) {
  let starting_after;
  const paidAndOpenLinks = [];
  const otherStatusLinks = [];

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

      console.log(`Invoice ID: ${invoice.id} / Number: ${invoice.number}`);
    }

    if (!invoices.has_more) break;
    starting_after = invoices.data[invoices.data.length - 1].id;
  }

  return { paidAndOpenLinks, otherStatusLinks };
}

// Handle POST: expects { year, month } in JSON body
export async function POST(request) {
  try {
    const body = await request.json();
    const { year, month } = body;

    // Basic input validation
    if (!year || !month) {
      return NextResponse.json(
        { message: "Please provide both year and month." },
        { status: 400 }
      );
    }

    const parsedYear = parseInt(year, 10);
    const parsedMonth = parseInt(month, 10) - 1; // zero-index
    if (
      isNaN(parsedYear) ||
      isNaN(parsedMonth) ||
      parsedMonth < 0 ||
      parsedMonth > 11
    ) {
      return NextResponse.json(
        { message: "Invalid year or month." },
        { status: 400 }
      );
    }

    // Build date range
    const startDate = new Date(parsedYear, parsedMonth, 1);
    const endDate = new Date(parsedYear, parsedMonth + 1, 0);
    endDate.setHours(23, 59, 59, 999);

    console.log("Start date:", startDate.toISOString());
    console.log("End date:", endDate.toISOString());

    const gte = Math.floor(startDate.getTime() / 1000);
    const lte = Math.floor(endDate.getTime() / 1000);

    // Setup axios with rate limiting
    const http = axiosRateLimit(axios.create(), { maxRPS: 80 });

    // For naming the final PDFs
    const monthNames = [
      "January","February","March","April","May","June",
      "July","August","September","October","November","December"
    ];
    const monthName = monthNames[parsedMonth];

    // We'll separate attachments for ET vs PC/PCP
    const attachmentsET = [];
    const attachmentsNonET = [];

    // Build up attachments for each Stripe key
    for (const configKey of Object.keys(STRIPE_KEYS)) {
      const stripeKey = STRIPE_KEYS[configKey];
      if (!stripeKey) {
        console.error(`Missing environment variable for ${configKey}, skipping this key.`);
        continue;
      }

      // Initialize Stripe
      const stripe = initStripe(stripeKey);

      // 1) Fetch the invoices
      const { paidAndOpenLinks, otherStatusLinks } = await getInvoices(stripe, gte, lte);

      // 2) Merge for each category
      const categories = [
        { name: "Paid_And_Open", links: paidAndOpenLinks },
        { name: "Other_Status", links: otherStatusLinks },
      ];

      for (const cat of categories) {
        let finalPdfBuffer;

        if (cat.links.length > 0) {
          // Download each invoice's PDF (skip if invalid or fails)
          const pdfBuffers = [];
          for (const invoice of cat.links) {
            const downloadedPdf = await downloadPdfInMemory(
              invoice.invoice_pdf,
              invoice.invoice_number,
              http
            );
            if (downloadedPdf) pdfBuffers.push(downloadedPdf);
          }

          // Merge them
          if (pdfBuffers.length > 0) {
            finalPdfBuffer = await mergePdfs(pdfBuffers);
          } else {
            // If every invoice failed or no valid links
            finalPdfBuffer = await createEmptyPdf();
          }
        } else {
          // No invoices in this category
          finalPdfBuffer = await createEmptyPdf();
        }

        // Prepare the attachment
        const attachment = {
          filename: `${configKey.toUpperCase()}-${cat.name}-${monthName}-${parsedYear}.pdf`,
          content: Buffer.from(finalPdfBuffer),
        };

        if (configKey === "ET") {
          attachmentsET.push(attachment);
        } else {
          attachmentsNonET.push(attachment);
        }
      }
    }

    // Email them out
    const adminEmail = process.env.ADMIN_EMAIL;
    const gmailAppPassword = process.env.GMAIL_APP_PASSWORD;
    if (!adminEmail || !gmailAppPassword) {
      return NextResponse.json(
        {
          message: "Missing credentials. Make sure ADMIN_EMAIL and GMAIL_APP_PASSWORD are set."
        },
        { status: 500 }
      );
    }

    // Nodemailer
    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: adminEmail,
        pass: gmailAppPassword,
      },
    });

    // 1) ET → mumair299792458u@gmail.com
    if (attachmentsET.length > 0) {
      try {
        await transporter.sendMail({
          from: adminEmail,
          to: "mumair299792458u@gmail.com",
          subject: `PDF Invoices for ${monthName} ${parsedYear} (ET)`,
          text: `Attached are the combined PDF invoices (ET) for ${monthName}, ${parsedYear}.`,
          attachments: attachmentsET,
        });
        console.log("ET email sent successfully.");
      } catch (err) {
        console.error("Error sending ET email:", err);
      }
    }

    // 2) PC & PCP → uzairshabbirsab@gmail.com
    if (attachmentsNonET.length > 0) {
      try {
        await transporter.sendMail({
          from: adminEmail,
          to: "uzairshabbirsab@gmail.com",
          subject: `PDF Invoices for ${monthName} ${parsedYear} (PC & PCP)`,
          text: `Attached are the combined PDF invoices (PC & PCP) for ${monthName}, ${parsedYear}.`,
          attachments: attachmentsNonET,
        });
        console.log("PC & PCP email sent successfully.");
      } catch (err) {
        console.error("Error sending PC/PCP email:", err);
      }
    }

    // Return success
    return NextResponse.json({ success: true }, { status: 200 });
  } catch (error) {
    console.error("Error generating or emailing PDFs:", error);
    return NextResponse.json(
      { success: false, message: error.message },
      { status: 500 }
    );
  }
}

// For safety, disallow GET requests
export async function GET() {
  return NextResponse.json(
    { message: "Method Not Allowed. Use POST." },
    { status: 405 }
  );
}
