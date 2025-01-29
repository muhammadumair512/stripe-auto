import { NextResponse } from "next/server";
import initStripe from "stripe";
import nodemailer from "nodemailer";
import { PDFDocument } from "pdf-lib";
import axios from "axios";
import axiosRateLimit from "axios-rate-limit";
import config from "../../config.json"; // <--- no change

// 1) Download PDF in memory
async function downloadPdfInMemory(url, invoiceNumber, http) {
  let attempt = 1;
  const maxAttempts = 5;

  while (attempt <= maxAttempts) {
    try {
      if (!url) {
        throw new Error(`PDF URL missing for invoice number: ${invoiceNumber}`);
      }
      const response = await http.get(url, { responseType: "arraybuffer" });
      console.log(`File downloaded in memory for invoice: ${invoiceNumber}`);
      return response.data;
    } catch (error) {
      console.error(`Error downloading ${invoiceNumber}:`, error);
      if (attempt === maxAttempts) {
        throw new Error(
          `Failed to download ${invoiceNumber} after ${attempt} attempts`
        );
      }
      console.log(`Retrying download of ${invoiceNumber} (attempt ${attempt})`);
    }
    attempt++;
  }
}

// 2) Merge PDF buffers in memory
async function mergePdfs(pdfBuffers) {
  const mergedPdf = await PDFDocument.create();
  for (const buffer of pdfBuffers) {
    const tempPdf = await PDFDocument.load(buffer);
    const copiedPages = await mergedPdf.copyPages(
      tempPdf,
      tempPdf.getPageIndices()
    );
    copiedPages.forEach((page) => mergedPdf.addPage(page));
  }
  return await mergedPdf.save(); // returns a Uint8Array
}

// 3) Create an empty PDF
async function createEmptyPdf() {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage();
  page.drawText("No data available for this category.");
  return await pdfDoc.save();
}

// 4) Fetch invoices from Stripe
async function getInvoices(stripe, gte, lte) {
  let starting_after;
  let paidAndOpenLinks = [];
  let otherStatusLinks = [];

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
  return { paidAndOpenLinks, otherStatusLinks };
}

export async function POST(request) {
  try {
    const body = await request.json();
    const { year, month } = body;

    // Validate input
    if (!year || !month) {
      return NextResponse.json(
        { message: "Please provide both year and month." },
        { status: 400 }
      );
    }

    const parsedYear = parseInt(year, 10);
    const parsedMonth = parseInt(month, 10) - 1;
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
      "January",
      "February",
      "March",
      "April",
      "May",
      "June",
      "July",
      "August",
      "September",
      "October",
      "November",
      "December"
    ];
    const monthName = monthNames[parsedMonth];

    // Instead of one attachments array,
    // we separate them based on configKey:
    const attachmentsET = [];      // For ET
    const attachmentsNonET = [];   // For PC and PCP

    // Go through each Stripe key
    for (const configKey of Object.keys(config)) {
      const stripe = initStripe(config[configKey]);
      const { paidAndOpenLinks, otherStatusLinks } = await getInvoices(stripe, gte, lte);

      // Two categories
      const categories = [
        { name: "Paid_And_Open", links: paidAndOpenLinks },
        { name: "Other_Status", links: otherStatusLinks },
      ];

      for (const cat of categories) {
        let finalPdfBuffer;

        if (cat.links.length > 0) {
          // Download and merge
          const pdfBuffers = [];
          for (const invoice of cat.links) {
            const buffer = await downloadPdfInMemory(
              invoice.invoice_pdf,
              invoice.invoice_number,
              http
            );
            if (buffer) pdfBuffers.push(buffer);
          }
          finalPdfBuffer = await mergePdfs(pdfBuffers);
        } else {
          // Create an empty PDF if no invoices
          finalPdfBuffer = await createEmptyPdf();
        }

        // Build the attachment object
        const attachment = {
          filename: `${configKey.toUpperCase()}-${cat.name}-${monthName}-${parsedYear}.pdf`,
          content: Buffer.from(finalPdfBuffer),
        };

        // If it's ET, push to attachmentsET; otherwise, push to attachmentsNonET
        if (configKey === "ET") {
          attachmentsET.push(attachment);
        } else {
          attachmentsNonET.push(attachment);
        }
      }
    }

    // Now email to two different addresses
    // We still use the same credentials from environment:
    const adminEmail = process.env.ADMIN_EMAIL;
    const gmailAppPassword = process.env.GMAIL_APP_PASSWORD;

    if (!adminEmail || !gmailAppPassword) {
      return NextResponse.json(
        {
          message:
            "Missing credentials. Make sure ADMIN_EMAIL and GMAIL_APP_PASSWORD are set."
        },
        { status: 500 }
      );
    }

    // Create the nodemailer transporter
    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: adminEmail,
        pass: gmailAppPassword
      }
    });

    // 1) Send ET attachments to mumair299792458u@gmail.com
    if (attachmentsET.length > 0) {
      await transporter.sendMail({
        from: adminEmail,
        to: "mumair299792458u@gmail.com",
        subject: `PDF Invoices for ${monthName} ${parsedYear} (ET)`,
        text: `Attached are the combined PDF invoices (ET) for ${monthName}, ${parsedYear}.`,
        attachments: attachmentsET
      });
    }

    // 2) Send PC/PCP attachments to umairshabbirsab@gmail.com
    if (attachmentsNonET.length > 0) {
      await transporter.sendMail({
        from: adminEmail,
        to: "uzairshabbirsab@gmail.com",
        subject: `PDF Invoices for ${monthName} ${parsedYear} (PC & PCP)`,
        text: `Attached are the combined PDF invoices (PC & PCP) for ${monthName}, ${parsedYear}.`,
        attachments: attachmentsNonET
      });
    }

    // Respond success if we made it here
    return NextResponse.json({ success: true }, { status: 200 });
  } catch (error) {
    console.error("Error generating or emailing PDFs:", error);
    return NextResponse.json(
      { success: false, message: error.message },
      { status: 500 }
    );
  }
}

export async function GET() {
  return NextResponse.json(
    { message: "Method Not Allowed. Use POST." },
    { status: 405 }
  );
}
