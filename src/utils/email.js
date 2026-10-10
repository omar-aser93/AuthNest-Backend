import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_API_KEY);

/** Email sender (Resend)  */
export async function sendEmail({ to, subject, html }) {
  try {
    await resend.emails.send({
      from: process.env.SMTP_FROM, // "AuthNest <no-reply@...>"
      to,
      subject,
      html,
    });

    console.log("📧 Email sent to:", to);
  } catch (error) {
    console.error("❌ Email send failed:", error);
    throw new Error("Email could not be sent");
  }
}






/** Older Email sender (Nodemailer & SendGrid), Became Paid with no free tier */

// import nodemailer from "nodemailer";

// // Create reusable transporter object using SMTP transport (SendGrid)
// export const transporter = nodemailer.createTransport({
//   host: process.env.SMTP_HOST,         // smtp.sendgrid.net
//   port: Number(process.env.SMTP_PORT), // 587
//   secure: false,                       // TLS STARTTLS
//   auth: {
//     user: process.env.SMTP_USER,       // "apikey"
//     pass: process.env.SMTP_PASS,       // SG.xxx
//   },
// });

// // Function to send email
// export const sendEmail = async ({ to, subject, html }) => {
//   try {
//     await transporter.sendMail({
//       from: process.env.SMTP_FROM,     // "AuthNest <no-reply@...>"
//       to,
//       subject,
//       html,
//     });
//     console.log("Email sent to:", to);
//   } catch (error) {
//     console.error("Email send failed:", error);
//     throw new Error("Email could not be sent");
//   }
// };
