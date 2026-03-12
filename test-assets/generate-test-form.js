/**
 * generate-test-form.js
 * Generates: test-form-mixed.pdf - a 15-page comprehensive form with a mix of
 * filled and empty fields covering every major form-field type.
 *
 * Run:  node generate-test-form.js
 *
 * Field types covered:
 *   - Single-line text fields (required & optional)
 *   - Multi-line text areas
 *   - Checkboxes (individual and groups)
 *   - Radio button groups (Yes/No and multi-option)
 *   - Date fields
 *   - Signature / initials fields
 *   - Conditional follow-up fields (triggered / not triggered)
 *   - Table-row Yes/No representations
 *   - Dropdown-style option lists (checkbox style)
 *   - Number / currency fields
 */

import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import fs from "fs/promises";

// ── Page dimensions (Letter) ──────────────────────────────────────────────────
const W = 612, H = 792;
const ML = 50, MR = 50, MT = 50;
const USABLE_W = W - ML - MR;

// ── Colours ───────────────────────────────────────────────────────────────────
const BLACK  = rgb(0,    0,    0   );
const GREY   = rgb(0.5,  0.5,  0.5 );
const RED    = rgb(0.8,  0,    0   );
const BLUE   = rgb(0,    0.2,  0.6 );
const LGREY  = rgb(0.93, 0.93, 0.93);

// ─────────────────────────────────────────────────────────────────────────────
// Drawing helpers
// ─────────────────────────────────────────────────────────────────────────────

function drawPageHeader(page, fonts, title, pageNum) {
  const { bold } = fonts;
  page.drawRectangle({ x: ML, y: H - MT - 22, width: USABLE_W, height: 22, color: BLUE });
  page.drawText(title, { x: ML + 6, y: H - MT - 16, size: 11, font: bold, color: rgb(1,1,1) });
  page.drawText(`Page ${pageNum} of 15`, { x: W - MR - 60, y: H - MT - 16, size: 9, font: fonts.regular, color: rgb(1,1,1) });
  return H - MT - 22 - 10; // cursor below header
}

function drawSectionBand(page, fonts, text, y) {
  page.drawRectangle({ x: ML, y: y - 16, width: USABLE_W, height: 18, color: LGREY });
  page.drawText(text, { x: ML + 4, y: y - 12, size: 10, font: fonts.bold, color: BLACK });
  return y - 16 - 8;
}

function drawLabel(page, fonts, text, x, y, required = false) {
  page.drawText(text, { x, y, size: 9, font: fonts.bold, color: BLACK });
  if (required) page.drawText(" *", { x: x + fonts.bold.widthOfTextAtSize(text, 9), y, size: 9, font: fonts.bold, color: RED });
}

function drawTextField(page, fonts, label, value, x, y, w, required = true) {
  drawLabel(page, fonts, label, x, y, required);
  page.drawRectangle({ x, y: y - 16, width: w, height: 14, borderColor: BLACK, borderWidth: 0.5, color: rgb(1,1,1) });
  if (value) {
    page.drawText(value, { x: x + 3, y: y - 13, size: 9, font: fonts.regular, color: BLACK });
  }
  return y - 16 - 8; // returns cursor Y after field
}

function drawMultilineField(page, fonts, label, value, x, y, w, h, required = true) {
  drawLabel(page, fonts, label, x, y, required);
  page.drawRectangle({ x, y: y - h, width: w, height: h, borderColor: BLACK, borderWidth: 0.5, color: rgb(1,1,1) });
  if (value) {
    // simple word-wrap by breaking every 80 chars
    const lines = value.match(/.{1,80}(\s|$)/g) || [value];
    lines.forEach((line, i) => {
      page.drawText(line.trim(), { x: x + 3, y: y - 13 - i * 12, size: 8, font: fonts.regular, color: BLACK });
    });
  }
  return y - h - 8;
}

function drawCheckbox(page, fonts, label, x, y, checked) {
  page.drawRectangle({ x, y: y - 1, width: 10, height: 10, borderColor: BLACK, borderWidth: 0.7, color: rgb(1,1,1) });
  if (checked) {
    page.drawLine({ start: { x: x + 1, y: y + 6 }, end: { x: x + 4, y: y + 1 }, thickness: 1.2, color: BLACK });
    page.drawLine({ start: { x: x + 4, y: y + 1 }, end: { x: x + 10, y: y + 9 }, thickness: 1.2, color: BLACK });
  }
  page.drawText(label, { x: x + 14, y, size: 9, font: fonts.regular, color: BLACK });
  return y - 16;
}

function drawRadio(page, fonts, label, x, y, selected) {
  // Draw circle for radio
  page.drawCircle({ x: x + 5, y: y + 5, size: 5, borderColor: BLACK, borderWidth: 0.7, color: rgb(1,1,1) });
  if (selected) {
    page.drawCircle({ x: x + 5, y: y + 5, size: 2.5, color: BLACK });
  }
  page.drawText(label, { x: x + 14, y, size: 9, font: fonts.regular, color: BLACK });
  return y - 16;
}

function drawYesNo(page, fonts, question, x, y, w, answer /* "yes" | "no" | null */) {
  page.drawText(question, { x, y, size: 9, font: fonts.regular, color: BLACK, maxWidth: w - 60 });
  const qh = Math.ceil(fonts.regular.widthOfTextAtSize(question, 9) / (w - 60)) * 12;
  const ry = y - Math.max(qh - 12, 0);
  drawRadio(page, fonts, "Yes", W - MR - 55, ry, answer === "yes");
  drawRadio(page, fonts, "No",  W - MR - 25, ry, answer === "no");
  return ry - 16;
}

function drawConditionalField(page, fonts, label, value, x, y, w, triggered, required = true) {
  // Visual indent + italic label to indicate conditional
  page.drawLine({ start: { x: x - 4, y: y + 4 }, end: { x: x - 4, y: y - 14 }, thickness: 1.5, color: GREY });
  page.drawText(`  ${label}`, { x, y, size: 8.5, font: fonts.italic, color: GREY });
  if (required && triggered) page.drawText(" *", { x: x + fonts.italic.widthOfTextAtSize(`  ${label}`, 8.5), y, size: 9, font: fonts.bold, color: RED });
  page.drawRectangle({ x, y: y - 14, width: w, height: 12, borderColor: triggered ? BLACK : GREY, borderWidth: 0.5, color: rgb(1,1,1) });
  if (value && triggered) {
    page.drawText(value, { x: x + 3, y: y - 11, size: 8, font: fonts.regular, color: BLACK });
  }
  return y - 14 - 10;
}

function drawSignatureLine(page, fonts, label, value, x, y, w) {
  page.drawText(label, { x, y, size: 9, font: fonts.bold, color: BLACK });
  page.drawLine({ start: { x, y: y - 14 }, end: { x: x + w, y: y - 14 }, thickness: 0.5, color: BLACK });
  if (value) page.drawText(value, { x: x + 3, y: y - 13, size: 9, font: fonts.regular, color: BLACK });
  return y - 14 - 10;
}

function drawTableRow(page, fonts, num, question, x, y, w, answer) {
  const bg = num % 2 === 0 ? LGREY : rgb(1,1,1);
  page.drawRectangle({ x, y: y - 14, width: w, height: 16, color: bg });
  page.drawText(`${num}.`, { x: x + 3, y: y - 10, size: 8.5, font: fonts.bold, color: BLACK });
  page.drawText(question, { x: x + 20, y: y - 10, size: 8.5, font: fonts.regular, color: BLACK, maxWidth: w - 80 });
  drawRadio(page, fonts, "Y", x + w - 55, y - 10, answer === "yes");
  drawRadio(page, fonts, "N", x + w - 28, y - 10, answer === "no");
  page.drawLine({ start: { x, y: y - 14 }, end: { x: x + w, y: y - 14 }, thickness: 0.3, color: GREY });
  return y - 16;
}

function col2(w) { return { c1: ML, c2: ML + w / 2 + 5, cw: w / 2 - 5 }; }
function col3(w) { return { c1: ML, c2: ML + w / 3 + 3, c3: ML + (w / 3) * 2 + 6, cw: w / 3 - 6 }; }

// ─────────────────────────────────────────────────────────────────────────────
// Main generator
// ─────────────────────────────────────────────────────────────────────────────

async function generate() {
  const pdfDoc = await PDFDocument.create();
  const regular  = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const bold     = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const italic   = await pdfDoc.embedFont(StandardFonts.HelveticaOblique);
  const boldItal = await pdfDoc.embedFont(StandardFonts.HelveticaBoldOblique);
  const fonts = { regular, bold, italic, boldItal };

  // ── PAGE 1: Entity / Fund Identification ─────────────────────────────────
  {
    const page = pdfDoc.addPage([W, H]);
    let y = drawPageHeader(page, fonts, "COMPREHENSIVE TEST FORM - Entity & Fund Identification", 1);
    y -= 4;
    page.drawText("Please complete ALL required fields marked *. Use block capitals for text fields.", { x: ML, y, size: 8, font: italic, color: GREY });
    y -= 16;

    y = drawSectionBand(page, fonts, "SECTION 1 - Entity Information", y);
    const c = col2(USABLE_W);
    y = drawTextField(page, fonts, "1. Legal / Beneficial Owner Name", "", ML, y, USABLE_W, true);
    y = drawTextField(page, fonts, "2. Registered Name", "", ML, y, USABLE_W, true);
    y -= 4;
    y = drawTextField(page, fonts, "3. Short Name (for statements)", "PSG Test Fund II", c.c1, y, c.cw, false);
    // restore y to same row for second col
    const row3y = y + 14 + 8 + 9;
    y = drawTextField(page, fonts, "4. Jurisdiction", "", c.c2, row3y, c.cw, true);

    y = drawSectionBand(page, fonts, "Jurisdiction & Domicile", y);
    page.drawText("Jurisdiction:", { x: ML, y, size: 9, font: bold, color: BLACK }); y -= 16;
    drawRadio(page, fonts, "US",     ML + 10, y, true);
    drawRadio(page, fonts, "Non-US", ML + 70, y, false);
    y -= 20;

    page.drawText("Domicile State or Country:", { x: ML, y, size: 9, font: bold, color: BLACK }); y -= 16;
    drawRadio(page, fonts, "Delaware",      ML + 10, y, true);
    drawRadio(page, fonts, "Cayman Islands",ML + 90, y, false);
    drawRadio(page, fonts, "Other",         ML + 210, y, false);
    y -= 20;

    y = drawSectionBand(page, fonts, "Entity Type (select ONE) *", y);
    const types = ["Individual","Joint Tenants","Tenants in Common","Individual Retirement Account","Trust",
                   "Partnership","LLC","S Corporation","Corporation (other than S Corp)","Fund of Funds",
                   "RIC","Endowment","Employee Benefit Plan","Keogh Plan","Not Applicable","Other"];
    let tx = ML;
    for (const t of types) {
      if (tx + 160 > W - MR) { tx = ML; y -= 16; }
      drawCheckbox(page, fonts, t, tx, y, t === "Partnership");
      tx += 160;
    }
    y -= 24;

    y = drawSectionBand(page, fonts, "Formation Details", y);
    const c3 = col3(USABLE_W);
    y = drawTextField(page, fonts, "5. Organization/Formation Date", "9/20/2023", c3.c1, y, c3.cw, true);
    const row5y = y + 14 + 8 + 9;
    drawTextField(page, fonts, "6. Tax ID / EIN", "", c3.c2, row5y, c3.cw, true);
    drawTextField(page, fonts, "7. State of Formation", "Delaware", c3.c3, row5y, c3.cw, true);
  }

  // ── PAGE 2: Contact Information ───────────────────────────────────────────
  {
    const page = pdfDoc.addPage([W, H]);
    let y = drawPageHeader(page, fonts, "Contact & Mailing Information", 2);
    y -= 4;

    y = drawSectionBand(page, fonts, "SECTION 2 - Principal Address", y);
    y = drawTextField(page, fonts, "Address Line 1", "100 Technology Drive", ML, y, USABLE_W, true);
    y = drawTextField(page, fonts, "Address Line 2 (Suite/Floor)", "", ML, y, USABLE_W, false);
    const c = col3(USABLE_W);
    y = drawTextField(page, fonts, "City", "Boston", c.c1, y, c.cw, true);
    const ry = y + 14 + 8 + 9;
    drawTextField(page, fonts, "State / Province", "MA", c.c2, ry, c.cw, true);
    drawTextField(page, fonts, "Postal / Zip Code", "", c.c3, ry, c.cw, true);
    const c2 = col2(USABLE_W);
    y = drawTextField(page, fonts, "Country", "United States", c2.c1, y, c2.cw, true);
    const ryc = y + 14 + 8 + 9;
    drawTextField(page, fonts, "County / Region", "", c2.c2, ryc, c2.cw, false);

    y = drawSectionBand(page, fonts, "SECTION 3 - Contact Details", y);
    y = drawTextField(page, fonts, "Primary Contact Name", "John Smith", c2.c1, y, c2.cw, true);
    const ryp = y + 14 + 8 + 9;
    drawTextField(page, fonts, "Title / Role", "", c2.c2, ryp, c2.cw, true);
    y = drawTextField(page, fonts, "Phone Number", "", c2.c1, y, c2.cw, true);
    const ryt = y + 14 + 8 + 9;
    drawTextField(page, fonts, "Fax Number", "", c2.c2, ryt, c2.cw, false);
    y = drawTextField(page, fonts, "Email Address", "jsmith@psgequity.com", ML, y, USABLE_W, true);
    y = drawTextField(page, fonts, "Alternate Email", "", ML, y, USABLE_W, false);

    y = drawSectionBand(page, fonts, "SECTION 4 - Mailing Address (if different from above)", y);
    page.drawText("Same as above?", { x: ML, y, size: 9, font: bold, color: BLACK });
    drawCheckbox(page, fonts, "Yes (skip this section)", ML + 110, y, true);
    drawCheckbox(page, fonts, "No (complete below)",    ML + 280, y, false);
    y -= 20;
    y = drawTextField(page, fonts, "Mailing Address Line 1", "", ML, y, USABLE_W, false);
    y = drawTextField(page, fonts, "Mailing City / State / Zip", "", ML, y, USABLE_W, false);
  }

  // ── PAGE 3: Investment Profile ────────────────────────────────────────────
  {
    const page = pdfDoc.addPage([W, H]);
    let y = drawPageHeader(page, fonts, "Investment Profile & Subscription Details", 3);
    y -= 4;

    y = drawSectionBand(page, fonts, "SECTION 5 - Subscription Amount", y);
    const c = col2(USABLE_W);
    y = drawTextField(page, fonts, "Subscription Amount (USD $)", "5,000,000.00", c.c1, y, c.cw, true);
    const ry = y + 14 + 8 + 9;
    drawTextField(page, fonts, "Commitment Amount (USD $)", "", c.c2, ry, c.cw, true);
    y = drawTextField(page, fonts, "Capital Commitment Currency", "USD", c.c1, y, c.cw, true);
    const ry2 = y + 14 + 8 + 9;
    drawTextField(page, fonts, "Preferred Share Class", "", c.c2, ry2, c.cw, true);

    y = drawSectionBand(page, fonts, "SECTION 6 - Source of Investment Funds (select all that apply) *", y);
    page.drawText("NOTE: At least ONE option must be selected.", { x: ML, y, size: 8, font: italic, color: RED }); y -= 16;
    const sources = ["Personal / Family Savings","Business Income","Investment Returns",
                     "Inheritance / Gift","Pension / Retirement Funds","Sale of Property","Other"];
    for (const s of sources) {
      y = drawCheckbox(page, fonts, s, ML + 10, y, false); // ALL unchecked → should flag as incomplete
    }
    y -= 4;

    y = drawSectionBand(page, fonts, "SECTION 7 - Investment Objective (select ONE) *", y);
    const objectives = ["Capital Preservation","Income Generation","Balanced Growth","Capital Appreciation","Speculation"];
    for (const o of objectives) {
      drawRadio(page, fonts, o, ML + 10, y, o === "Capital Appreciation");
      y -= 16;
    }
    y -= 4;

    y = drawSectionBand(page, fonts, "SECTION 8 - Risk Tolerance (select ONE) *", y);
    const risks = ["Conservative","Moderate","Aggressive","Very Aggressive"];
    let rx = ML + 10;
    for (const r of risks) {
      drawRadio(page, fonts, r, rx, y, false); // NONE selected → should flag
      rx += 120;
    }
    y -= 24;

    y = drawSectionBand(page, fonts, "SECTION 9 - Investment Experience", y);
    y = drawTextField(page, fonts, "Years of Investment Experience", "15", c.c1, y, c.cw, true);
    const ry3 = y + 14 + 8 + 9;
    drawTextField(page, fonts, "Number of Prior Fund Investments", "", c.c2, ry3, c.cw, true);
  }

  // ── PAGE 4: Investor / Accreditation Status ───────────────────────────────
  {
    const page = pdfDoc.addPage([W, H]);
    let y = drawPageHeader(page, fonts, "Investor Status & Accreditation", 4);
    y -= 4;

    y = drawSectionBand(page, fonts, "SECTION 10 - Accredited Investor Status", y);
    y = drawYesNo(page, fonts, "10a. Is the investor an Accredited Investor as defined under Rule 501 of Regulation D?", ML, y, USABLE_W, "yes");

    page.drawText("Basis for Accredited Investor status (select all that apply) *:", { x: ML, y, size: 9, font: bold, color: BLACK }); y -= 16;
    const acBases = [
      "Net worth exceeds $1,000,000 (excluding primary residence)",
      "Annual income exceeds $200,000 (individual) or $300,000 (joint) in last 2 years",
      "Director, executive officer, or general partner of the issuer",
      "Investment company, bank, insurance company, or registered investment adviser",
      "Entity with total assets in excess of $5,000,000",
      "Knowledgeable employee of the fund",
    ];
    for (const b of acBases) {
      y = drawCheckbox(page, fonts, b, ML + 10, y, b.includes("Net worth"));
    }
    y -= 4;

    y = drawSectionBand(page, fonts, "SECTION 11 - Qualified Purchaser Status", y);
    y = drawYesNo(page, fonts, "11a. Is the investor a Qualified Purchaser as defined in Section 2(a)(51) of the Investment Company Act?", ML, y, USABLE_W, null); // not answered → should flag

    y = drawSectionBand(page, fonts, "SECTION 12 - ERISA / Benefit Plan Investor", y);
    y = drawYesNo(page, fonts, "12a. Is the investor an employee benefit plan subject to ERISA?", ML, y, USABLE_W, "no");
    y = drawConditionalField(page, fonts, "If Yes, what percentage of plan assets does this investment represent?", "", ML + 20, y, USABLE_W - 20, false);
    y = drawYesNo(page, fonts, "12b. Is the investor a governmental plan (as defined in ERISA Section 3(32))?", ML, y, USABLE_W, "no");
    y = drawConditionalField(page, fonts, "If Yes, identify the governmental plan and applicable law:", "", ML + 20, y, USABLE_W - 20, false);
    y = drawYesNo(page, fonts, "12c. Is the investor a 'fund of funds' or other entity that holds plan assets?", ML, y, USABLE_W, "yes");
    y = drawConditionalField(page, fonts, "If Yes, state the percentage of assets attributable to benefit plan investors:", "", ML + 20, y, USABLE_W - 20, true); // triggered → should flag
  }

  // ── PAGE 5: US Person / Tax Status ───────────────────────────────────────
  {
    const page = pdfDoc.addPage([W, H]);
    let y = drawPageHeader(page, fonts, "US Person & Tax Status", 5);
    y -= 4;

    y = drawSectionBand(page, fonts, "SECTION 13 - US Person Status", y);
    y = drawYesNo(page, fonts, "13a. Is the investor a 'US Person' as defined under Regulation S of the Securities Act of 1933?", ML, y, USABLE_W, "no");
    y = drawConditionalField(page, fonts, "If Yes, provide the investor's SSN / EIN:", "", ML + 20, y, USABLE_W - 20, false);
    y = drawYesNo(page, fonts, "13b. Is the investor subscribing for the account or benefit of a US Person?", ML, y, USABLE_W, "yes");
    y = drawConditionalField(page, fonts, "If Yes, identify the US Person:", "", ML + 20, y, USABLE_W - 20, true); // triggered → should flag
    y = drawYesNo(page, fonts, "13c. Is the investor subject to US backup withholding?", ML, y, USABLE_W, "no");
    y = drawConditionalField(page, fonts, "If Yes, explain why withholding applies:", "", ML + 20, y, USABLE_W - 20, false);

    y = drawSectionBand(page, fonts, "SECTION 14 - Tax Classification", y);
    page.drawText("14a. US Tax Classification (select ONE) *:", { x: ML, y, size: 9, font: bold, color: BLACK }); y -= 16;
    const taxClass = ["Individual / Sole Proprietor","C Corporation","S Corporation","Partnership","Trust / Estate","LLC (single-member)","LLC (multi-member)","Other"];
    for (const tc of taxClass) {
      drawRadio(page, fonts, tc, ML + 10, y, tc === "Partnership");
      y -= 14;
    }
    y -= 4;

    y = drawSectionBand(page, fonts, "SECTION 15 - FATCA", y);
    y = drawYesNo(page, fonts, "15a. Is the investor a Foreign Financial Institution (FFI) for FATCA purposes?", ML, y, USABLE_W, "no");
    y = drawConditionalField(page, fonts, "If Yes, provide Global Intermediary Identification Number (GIIN):", "", ML + 20, y, USABLE_W - 20, false);
    const c = col2(USABLE_W);
    y = drawTextField(page, fonts, "15b. Country of Tax Residence", "", c.c1, y, c.cw, true); // required, empty → should flag
    const ryt = y + 14 + 8 + 9;
    drawTextField(page, fonts, "15c. Foreign Tax Identification Number", "", c.c2, ryt, c.cw, false);
  }

  // ── PAGE 6: Anti-Money Laundering ─────────────────────────────────────────
  {
    const page = pdfDoc.addPage([W, H]);
    let y = drawPageHeader(page, fonts, "Anti-Money Laundering & Know Your Customer", 6);
    y -= 4;

    y = drawSectionBand(page, fonts, "SECTION 16 - Source of Wealth", y);
    y = drawTextField(page, fonts, "16a. Describe the primary source of wealth for this investment", "Business operations and investment returns from PSG portfolio", ML, y, USABLE_W, true);
    y = drawTextField(page, fonts, "16b. Country where wealth was generated", "", ML, y, USABLE_W, true); // empty → should flag
    y = drawMultilineField(page, fonts, "16c. Provide additional detail on the nature and origin of funds (if required by jurisdiction)", "", ML, y, USABLE_W, 40, false);

    y = drawSectionBand(page, fonts, "SECTION 17 - Politically Exposed Person (PEP)", y);
    y = drawYesNo(page, fonts, "17a. Is the investor, or any beneficial owner of the investor, a Politically Exposed Person (PEP)?", ML, y, USABLE_W, "no");
    y = drawConditionalField(page, fonts, "If Yes, identify the PEP and their position / role:", "", ML + 20, y, USABLE_W - 20, false);
    y = drawYesNo(page, fonts, "17b. Is the investor, or any beneficial owner, an immediate family member or close associate of a PEP?", ML, y, USABLE_W, "no");
    y = drawConditionalField(page, fonts, "If Yes, describe the relationship to the PEP:", "", ML + 20, y, USABLE_W - 20, false);

    y = drawSectionBand(page, fonts, "SECTION 18 - Sanctions", y);
    y = drawYesNo(page, fonts, "18a. Is the investor subject to any economic or trade sanctions imposed by the US, EU, or UN?", ML, y, USABLE_W, "no");
    y = drawConditionalField(page, fonts, "If Yes, identify the applicable sanctions:", "", ML + 20, y, USABLE_W - 20, false);
    y = drawYesNo(page, fonts, "18b. Is the investor located in, organised under the laws of, or a national of a sanctioned country?", ML, y, USABLE_W, "no");

    y = drawSectionBand(page, fonts, "SECTION 19 - Beneficial Ownership", y);
    y = drawYesNo(page, fonts, "19a. Does any natural person own or control 25% or more of the investor?", ML, y, USABLE_W, "yes");
    y = drawConditionalField(page, fonts, "If Yes, provide name(s), nationality, and percentage of ownership:", "", ML + 20, y, USABLE_W - 20, true); // triggered → should flag
    y = drawTextField(page, fonts, "19b. Name of AML Compliance Officer (if applicable)", "", ML, y, USABLE_W, false);
  }

  // ── PAGE 7: Banking & Payment Instructions ────────────────────────────────
  {
    const page = pdfDoc.addPage([W, H]);
    let y = drawPageHeader(page, fonts, "Banking & Payment Instructions", 7);
    y -= 4;

    y = drawSectionBand(page, fonts, "SECTION 20 - Subscription Payment Bank", y);
    const c2 = col2(USABLE_W);
    y = drawTextField(page, fonts, "20a. Bank Name", "", ML, y, USABLE_W, true); // empty → should flag
    y = drawTextField(page, fonts, "20b. Bank Address", "100 Federal Street, Boston MA 02110", ML, y, USABLE_W, true);
    y = drawTextField(page, fonts, "20c. Account Name", "PSG Equity Partners IV LP", c2.c1, y, c2.cw, true);
    const ryc = y + 14 + 8 + 9;
    drawTextField(page, fonts, "20d. Account Number", "", c2.c2, ryc, c2.cw, true); // empty → should flag
    y = drawTextField(page, fonts, "20e. ABA Routing Number", "021000021", c2.c1, y, c2.cw, true);
    const ryr = y + 14 + 8 + 9;
    drawTextField(page, fonts, "20f. SWIFT / BIC Code", "", c2.c2, ryr, c2.cw, false);
    y = drawTextField(page, fonts, "20g. IBAN (if applicable)", "", ML, y, USABLE_W, false);

    y = drawSectionBand(page, fonts, "SECTION 21 - Distribution / Redemption Instructions", y);
    page.drawText("Same as subscription account above?", { x: ML, y, size: 9, font: bold, color: BLACK });
    drawRadio(page, fonts, "Yes", ML + 210, y, false);
    drawRadio(page, fonts, "No",  ML + 260, y, true); // No → conditional fields below should be triggered
    y -= 20;
    y = drawConditionalField(page, fonts, "If No - Distribution Bank Name:", "", ML + 20, y, USABLE_W - 20, true); // should flag
    y = drawConditionalField(page, fonts, "If No - Distribution Account Number:", "", ML + 20, y, USABLE_W - 20, true); // should flag
    y = drawConditionalField(page, fonts, "If No - Distribution ABA Routing Number:", "314074269", ML + 20, y, USABLE_W - 20, true); // triggered, filled

    y = drawSectionBand(page, fonts, "SECTION 22 - Payment Method for Capital Calls", y);
    const methods = ["Wire Transfer","ACH","Check","Other"];
    let mx = ML + 10;
    for (const m of methods) {
      drawRadio(page, fonts, m, mx, y, m === "Wire Transfer");
      mx += 110;
    }
    y -= 24;
    y = drawConditionalField(page, fonts, "If Other, specify payment method:", "", ML + 20, y, USABLE_W - 20, false);
  }

  // ── PAGE 8: Authorized Signatories ────────────────────────────────────────
  {
    const page = pdfDoc.addPage([W, H]);
    let y = drawPageHeader(page, fonts, "Authorized Signatories & Key Persons", 8);
    y -= 4;

    y = drawSectionBand(page, fonts, "SECTION 23 - Entity/Person Exercising Investment Discretion", y);
    const c2 = col2(USABLE_W);
    y = drawTextField(page, fonts, "23a. Name of Entity / Person", "Morgan Stanley AIP GP LP", ML, y, USABLE_W, true);
    y = drawTextField(page, fonts, "23b. Relationship to Investor", "General Partner", c2.c1, y, c2.cw, true);
    const ryr = y + 14 + 8 + 9;
    drawTextField(page, fonts, "23c. Jurisdiction of Formation", "Delaware", c2.c2, ryr, c2.cw, true);

    y = drawSectionBand(page, fonts, "SECTION 24 - Signatory 1 (Required)", y);
    y = drawTextField(page, fonts, "24a. Full Legal Name", "James A. Richardson", ML, y, USABLE_W, true);
    y = drawTextField(page, fonts, "24b. Title", "", c2.c1, y, c2.cw, true); // empty → should flag
    const ryt = y + 14 + 8 + 9;
    drawTextField(page, fonts, "24c. Email Address", "j.richardson@morganstanley.com", c2.c2, ryt, c2.cw, true);
    y = drawTextField(page, fonts, "24d. Phone", "", c2.c1, y, c2.cw, true); // empty → should flag
    const ryp = y + 14 + 8 + 9;
    drawTextField(page, fonts, "24e. Passport / ID Number", "", c2.c2, ryp, c2.cw, false);

    y = drawSectionBand(page, fonts, "SECTION 25 - Signatory 2 (if required)", y);
    y = drawYesNo(page, fonts, "25a. Is a second authorized signatory required?", ML, y, USABLE_W, "yes");
    y = drawConditionalField(page, fonts, "If Yes - Signatory 2 Full Legal Name:", "", ML + 20, y, USABLE_W - 20, true); // triggered → should flag
    y = drawConditionalField(page, fonts, "If Yes - Signatory 2 Title:", "", ML + 20, y, USABLE_W - 20, true); // triggered → should flag
    y = drawConditionalField(page, fonts, "If Yes - Signatory 2 Email:", "", ML + 20, y, USABLE_W - 20, true); // triggered → should flag

    y = drawSectionBand(page, fonts, "SECTION 26 - General Partner or Managing Member", y);
    y = drawTextField(page, fonts, "26a. General Partner / Managing Member Name", "", ML, y, USABLE_W, true); // empty → should flag
    y = drawTextField(page, fonts, "26b. GP / MM Jurisdiction", "", c2.c1, y, c2.cw, true); // empty
    const ryg = y + 14 + 8 + 9;
    drawTextField(page, fonts, "26c. GP / MM Registration Number", "", c2.c2, ryg, c2.cw, false);
  }

  // ── PAGE 9: Representations (Table Format) ───────────────────────────────
  {
    const page = pdfDoc.addPage([W, H]);
    let y = drawPageHeader(page, fonts, "Representations & Warranties - Table of Questions", 9);
    y -= 4;

    page.drawText("Answer YES or NO to each question. Leave no question unanswered. *", { x: ML, y, size: 8.5, font: italic, color: RED }); y -= 16;

    // Table header
    page.drawRectangle({ x: ML, y: y - 14, width: USABLE_W, height: 16, color: BLUE });
    page.drawText("#", { x: ML + 3, y: y - 10, size: 9, font: bold, color: rgb(1,1,1) });
    page.drawText("Question", { x: ML + 20, y: y - 10, size: 9, font: bold, color: rgb(1,1,1) });
    page.drawText("Yes  No", { x: W - MR - 55, y: y - 10, size: 9, font: bold, color: rgb(1,1,1) });
    y -= 16;

    const tableQs = [
      ["Has the investor read and understood the Private Placement Memorandum in full?", "yes"],
      ["Is the investor acquiring the interest for its own account and not for resale?", "yes"],
      ["Does the investor understand there is no guarantee of return of principal?", "yes"],
      ["Has the investor had the opportunity to ask questions of the General Partner?", "yes"],
      ["Is the investor aware of the illiquid nature of this investment?", "yes"],
      ["Does the investor have sufficient liquidity for the investment term?", "yes"],
      ["Has the investor consulted independent legal and tax advisors?", "yes"],
      ["Is there any material adverse change in the investor's financial position pending?", null],  // not answered
      ["Does the investor have any pending regulatory actions or investigations?", null],             // not answered
      ["Has the investor previously been denied access to any investment fund?", null],              // not answered
      ["Does the investor understand and agree to the key-man provisions?", "yes"],
      ["Does the investor consent to electronic delivery of fund documents?", "yes"],
    ];

    for (let i = 0; i < tableQs.length; i++) {
      const [q, ans] = tableQs[i];
      y = drawTableRow(page, fonts, i + 1, q, ML, y, USABLE_W, ans);
    }
    y -= 8;

    y = drawSectionBand(page, fonts, "If any answer above is 'No', provide explanation:", y);
    y = drawMultilineField(page, fonts, "Explanation for any 'No' answers:", "", ML, y, USABLE_W, 36, false);

    y = drawSectionBand(page, fonts, "Additional Certifications", y);
    y = drawCheckbox(page, fonts, "I confirm that all information provided in this form is true, accurate, and complete to the best of my knowledge.", ML + 10, y, true);
    y = drawCheckbox(page, fonts, "I agree to promptly notify the Fund of any material change to the information provided herein.", ML + 10, y, true);
    y = drawCheckbox(page, fonts, "I have reviewed and agree to be bound by the Limited Partnership Agreement.", ML + 10, y, false); // unchecked → should flag
  }

  // ── PAGE 10: Regulatory & Compliance ─────────────────────────────────────
  {
    const page = pdfDoc.addPage([W, H]);
    let y = drawPageHeader(page, fonts, "Regulatory & Compliance Disclosures", 10);
    y -= 4;

    y = drawSectionBand(page, fonts, "SECTION 27 - Investment Adviser Registration", y);
    y = drawYesNo(page, fonts, "27a. Is the investor a registered investment adviser?", ML, y, USABLE_W, "no");
    y = drawConditionalField(page, fonts, "If Yes, provide CRD number:", "", ML + 20, y, USABLE_W - 20, false);
    y = drawYesNo(page, fonts, "27b. Is the investor a broker-dealer registered with FINRA?", ML, y, USABLE_W, "no");

    y = drawSectionBand(page, fonts, "SECTION 28 - FOIA & Confidentiality", y);
    y = drawYesNo(page, fonts, "28a. Is the investor a governmental entity subject to FOIA or similar public disclosure laws?", ML, y, USABLE_W, "no");
    y = drawConditionalField(page, fonts, "If Yes, what FOIA or public records law applies?", "", ML + 20, y, USABLE_W - 20, false);
    y = drawYesNo(page, fonts, "28b. Would the investor's records be subject to disclosure under any public records law?", ML, y, USABLE_W, "no");

    y = drawSectionBand(page, fonts, "SECTION 29 - Related Party Disclosure", y);
    y = drawYesNo(page, fonts, "29a. Does the investor have any affiliation with the Fund's General Partner or its affiliates?", ML, y, USABLE_W, "no");
    y = drawConditionalField(page, fonts, "If Yes, describe the affiliation:", "", ML + 20, y, USABLE_W - 20, false);
    y = drawYesNo(page, fonts, "29b. Does the investor have any existing investment in any other fund managed by the GP?", ML, y, USABLE_W, "yes");
    y = drawConditionalField(page, fonts, "If Yes, name the fund(s):", "PSG Equity Partners III LP", ML + 20, y, USABLE_W - 20, true); // triggered and filled

    y = drawSectionBand(page, fonts, "SECTION 30 - Compliance Certifications", y);
    y = drawTextField(page, fonts, "30a. Name of Chief Compliance Officer (if applicable)", "", ML, y, USABLE_W, false);
    const c2 = col2(USABLE_W);
    y = drawTextField(page, fonts, "30b. Compliance Phone", "", c2.c1, y, c2.cw, false);
    const ryc = y + 14 + 8 + 9;
    drawTextField(page, fonts, "30c. Compliance Email", "", c2.c2, ryc, c2.cw, false);
  }

  // ── PAGE 11: Financial & Net Worth ────────────────────────────────────────
  {
    const page = pdfDoc.addPage([W, H]);
    let y = drawPageHeader(page, fonts, "Financial Information & Qualified Purchaser Qualification", 11);
    y -= 4;

    y = drawSectionBand(page, fonts, "SECTION 31 - Net Worth / Net Investment Assets", y);
    const c2 = col2(USABLE_W);
    y = drawTextField(page, fonts, "31a. Total Net Worth (USD $)", "", c2.c1, y, c2.cw, true); // empty → should flag
    const ryw = y + 14 + 8 + 9;
    drawTextField(page, fonts, "31b. Net Investment Assets (USD $)", "25,000,000.00", c2.c2, ryw, c2.cw, true);
    y = drawTextField(page, fonts, "31c. Total Assets Under Management (USD $)", "150,000,000.00", c2.c1, y, c2.cw, false);
    const rya = y + 14 + 8 + 9;
    drawTextField(page, fonts, "31d. Annual Income (most recent year, USD $)", "", c2.c2, rya, c2.cw, false);

    y = drawSectionBand(page, fonts, "SECTION 32 - Qualified Purchaser Basis (select all that apply) *", y);
    const qpBases = [
      "Owns not less than $5,000,000 in investments",
      "Family company owning not less than $5,000,000 in investments",
      "Trust (not formed to acquire securities) with >=$5M in investments",
      "Person acting for own account with >=$25M in investments",
      "Qualified institutional buyer under Rule 144A",
    ];
    for (const b of qpBases) {
      y = drawCheckbox(page, fonts, b, ML + 10, y, b.includes("$5,000,000 in investments") && !b.includes("Family"));
    }
    y -= 4;

    y = drawSectionBand(page, fonts, "SECTION 33 - Investment Horizon & Liquidity", y);
    page.drawText("33a. Investment Horizon (select ONE) *:", { x: ML, y, size: 9, font: bold, color: BLACK }); y -= 16;
    const horizons = ["1-3 years","3-5 years","5-7 years","7-10 years","10+ years"];
    let hx = ML + 10;
    for (const h of horizons) {
      drawRadio(page, fonts, h, hx, y, h === "7-10 years");
      hx += 95;
    }
    y -= 20;
    y = drawYesNo(page, fonts, "33b. Does the investor have sufficient liquid assets outside this investment for living/operating expenses?", ML, y, USABLE_W, "yes");
    y = drawTextField(page, fonts, "33c. Estimated % of liquid net worth represented by this investment", "", ML, y, USABLE_W, false);
  }

  // ── PAGE 12: Notices & Communication Preferences ─────────────────────────
  {
    const page = pdfDoc.addPage([W, H]);
    let y = drawPageHeader(page, fonts, "Notices, Communication Preferences & Reporting", 12);
    y -= 4;

    y = drawSectionBand(page, fonts, "SECTION 34 - Notice Address (for legal/fund notices)", y);
    const c2 = col2(USABLE_W);
    y = drawTextField(page, fonts, "34a. Notice Recipient Name", "", ML, y, USABLE_W, true); // empty → should flag
    y = drawTextField(page, fonts, "34b. Notice Address Line 1", "", ML, y, USABLE_W, true); // empty → should flag
    y = drawTextField(page, fonts, "34c. Notice City / State / Zip", "", c2.c1, y, c2.cw, true); // empty
    const ryc = y + 14 + 8 + 9;
    drawTextField(page, fonts, "34d. Notice Country", "United States", c2.c2, ryc, c2.cw, true);
    y = drawTextField(page, fonts, "34e. Notice Email Address", "legal@psgequity.com", ML, y, USABLE_W, true);

    y = drawSectionBand(page, fonts, "SECTION 35 - Communication Preferences", y);
    page.drawText("35a. Preferred method for fund communications (select ONE) *:", { x: ML, y, size: 9, font: bold, color: BLACK }); y -= 16;
    const commMethods = ["Email (electronic)","Physical Mail","Both Email and Mail","Online Portal Only"];
    let cx = ML + 10;
    for (const m of commMethods) {
      drawRadio(page, fonts, m, cx, y, m === "Email (electronic)");
      cx += 120;
    }
    y -= 20;
    y = drawCheckbox(page, fonts, "I consent to receive tax documents (K-1, etc.) electronically.", ML + 10, y, true);
    y = drawCheckbox(page, fonts, "I would like to receive quarterly investor letters.", ML + 10, y, true);
    y = drawCheckbox(page, fonts, "I would like to receive monthly capital account statements.", ML + 10, y, false);
    y -= 4;

    y = drawSectionBand(page, fonts, "SECTION 36 - Referral / How Did You Hear About Us (optional)", y);
    const referrals = ["Existing LP Referral","Placement Agent","Conference / Event","Website","Direct Outreach","Other"];
    let rx = ML + 10;
    for (const r of referrals) {
      if (rx + 110 > W - MR) { rx = ML + 10; y -= 16; }
      drawCheckbox(page, fonts, r, rx, y, false); // all unchecked - optional, should NOT flag
      rx += 110;
    }
    y -= 24;

    y = drawSectionBand(page, fonts, "SECTION 37 - Special Instructions (optional)", y);
    y = drawMultilineField(page, fonts, "37a. Any special instructions regarding capital calls, distributions, or reporting:", "", ML, y, USABLE_W, 40, false);
  }

  // ── PAGE 13: Side Letter / Special Terms ─────────────────────────────────
  {
    const page = pdfDoc.addPage([W, H]);
    let y = drawPageHeader(page, fonts, "Side Letter Requests & Special Terms", 13);
    y -= 4;

    y = drawSectionBand(page, fonts, "SECTION 38 - Side Letter Requests", y);
    y = drawYesNo(page, fonts, "38a. Is the investor requesting any side letter or special terms not in the standard LPA?", ML, y, USABLE_W, "yes");
    y = drawConditionalField(page, fonts, "If Yes, briefly describe the requested provisions:", "", ML + 20, y, USABLE_W - 20, true); // triggered → should flag
    y = drawYesNo(page, fonts, "38b. Is the investor requesting most-favored-nation (MFN) status?", ML, y, USABLE_W, "no");
    y = drawYesNo(page, fonts, "38c. Is the investor requesting any management fee or carried interest reduction?", ML, y, USABLE_W, "no");
    y = drawConditionalField(page, fonts, "If Yes, state the requested reduction:", "", ML + 20, y, USABLE_W - 20, false);

    y = drawSectionBand(page, fonts, "SECTION 39 - Co-Investment Rights", y);
    y = drawYesNo(page, fonts, "39a. Is the investor requesting co-investment rights?", ML, y, USABLE_W, "no");
    y = drawConditionalField(page, fonts, "If Yes, describe the requested co-investment rights:", "", ML + 20, y, USABLE_W - 20, false);
    y = drawTextField(page, fonts, "39b. Preferred co-investment notification period (days)", "", ML, y, USABLE_W, false);

    y = drawSectionBand(page, fonts, "SECTION 40 - Reporting Requirements", y);
    y = drawYesNo(page, fonts, "40a. Does the investor have specific reporting requirements due to regulatory obligations?", ML, y, USABLE_W, "yes");
    y = drawConditionalField(page, fonts, "If Yes, describe the reporting requirements:", "Quarterly ILPA-standard reporting required per state pension board regulations.", ML + 20, y, USABLE_W - 20, true); // triggered, filled
    y = drawYesNo(page, fonts, "40b. Does the investor require GIPS-compliant performance reports?", ML, y, USABLE_W, "no");
    const c2 = col2(USABLE_W);
    y = drawTextField(page, fonts, "40c. Required report frequency", "", c2.c1, y, c2.cw, false);
    const ryr = y + 14 + 8 + 9;
    drawTextField(page, fonts, "40d. Required report format", "", c2.c2, ryr, c2.cw, false);
  }

  // ── PAGE 14: Miscellaneous Certifications ─────────────────────────────────
  {
    const page = pdfDoc.addPage([W, H]);
    let y = drawPageHeader(page, fonts, "Miscellaneous Certifications & Acknowledgements", 14);
    y -= 4;

    y = drawSectionBand(page, fonts, "SECTION 41 - Data Privacy Consent", y);
    page.drawText("The Fund and its affiliates will process your personal data for the purpose of managing your investment.", { x: ML, y, size: 8, font: italic, color: GREY, maxWidth: USABLE_W }); y -= 24;
    y = drawCheckbox(page, fonts, "I consent to the processing of my personal data as described in the Fund's Privacy Notice. *", ML + 10, y, false); // unchecked → should flag
    y = drawCheckbox(page, fonts, "I consent to the transfer of my personal data to third-party service providers (e.g. auditors, legal counsel).", ML + 10, y, true);
    y = drawCheckbox(page, fonts, "I consent to cross-border transfer of personal data where required.", ML + 10, y, false); // optional, context-dependent

    y = drawSectionBand(page, fonts, "SECTION 42 - Risk Acknowledgements", y);
    const riskAcks = [
      "I understand that past performance is not indicative of future results.",
      "I understand that investments in private equity are illiquid and long-term in nature.",
      "I acknowledge that there is no public market for the interests and none is expected to develop.",
      "I understand that the Fund may use leverage, which increases risk of loss.",
      "I am aware that the Fund invests in early-stage and growth-stage companies, which carry significant risk.",
    ];
    for (const ack of riskAcks) {
      y = drawCheckbox(page, fonts, ack, ML + 10, y, true);
    }
    y -= 4;

    y = drawSectionBand(page, fonts, "SECTION 43 - Subscription Agreement Acknowledgement", y);
    page.drawText("By signing below, the investor acknowledges and agrees to the following:", { x: ML, y, size: 9, font: regular, color: BLACK }); y -= 14;
    const ackItems = [
      "The investor has received, read, and understood the Private Placement Memorandum.",
      "The investor has received, read, and agreed to the Limited Partnership Agreement.",
      "The investor has received, read, and agreed to the Subscription Agreement.",
      "All representations made herein are true and correct as of the date of signing.",
    ];
    for (const item of ackItems) {
      page.drawText(`*  ${item}`, { x: ML + 10, y, size: 8.5, font: regular, color: BLACK, maxWidth: USABLE_W - 10 }); y -= 14;
    }
    y -= 4;

    y = drawSectionBand(page, fonts, "SECTION 44 - Other Disclosures", y);
    y = drawTextField(page, fonts, "44a. Name of Investment Adviser (if any)", "", ML, y, USABLE_W, false);
    y = drawTextField(page, fonts, "44b. Name of Placement Agent (if any)", "", ML, y, USABLE_W, false);
    y = drawMultilineField(page, fonts, "44c. Any other material information the investor wishes to disclose:", "", ML, y, USABLE_W, 36, false);
  }

  // ── PAGE 15: Signature & Execution ───────────────────────────────────────
  {
    const page = pdfDoc.addPage([W, H]);
    let y = drawPageHeader(page, fonts, "Execution - Signatures & Certification", 15);
    y -= 4;

    // Certification block
    page.drawRectangle({ x: ML, y: y - 58, width: USABLE_W, height: 60, borderColor: BLACK, borderWidth: 0.5, color: LGREY });
    page.drawText("CERTIFICATION", { x: ML + 6, y: y - 12, size: 10, font: bold, color: BLACK });
    page.drawText(
      "By executing this Subscription Agreement, the undersigned investor (i) makes each of the representations, warranties, and certifications\n" +
      "set forth herein, (ii) acknowledges having received and reviewed all offering documents, and (iii) agrees to be bound by all terms\n" +
      "and conditions of the Limited Partnership Agreement and this Subscription Agreement.",
      { x: ML + 6, y: y - 24, size: 8, font: italic, color: BLACK, maxWidth: USABLE_W - 12, lineGap: 2 }
    );
    y -= 68;

    y = drawSectionBand(page, fonts, "INVESTOR EXECUTION", y);
    const c2 = col2(USABLE_W);
    y = drawSignatureLine(page, fonts, "Investor Signature *", "", ML, y, c2.cw);
    const rys = y + 14 + 10 + 9;
    drawSignatureLine(page, fonts, "Date *", "", c2.c2, rys, c2.cw); // empty → should flag
    y = drawTextField(page, fonts, "Print Name", "PSG Equity Partners IV LP", c2.c1, y, c2.cw, true);
    const ryp = y + 14 + 8 + 9;
    drawTextField(page, fonts, "Title *", "", c2.c2, ryp, c2.cw, true); // empty → should flag

    y = drawSectionBand(page, fonts, "SIGNATORY 2 (if applicable)", y);
    y = drawSignatureLine(page, fonts, "Signatory 2 Signature", "", c2.c1, y, c2.cw);
    const rys2 = y + 14 + 10 + 9;
    drawSignatureLine(page, fonts, "Date", "", c2.c2, rys2, c2.cw);
    y = drawTextField(page, fonts, "Print Name", "", c2.c1, y, c2.cw, false);
    const ryp2 = y + 14 + 8 + 9;
    drawTextField(page, fonts, "Title", "", c2.c2, ryp2, c2.cw, false);

    y = drawSectionBand(page, fonts, "ACCEPTED BY GENERAL PARTNER", y);
    y = drawSignatureLine(page, fonts, "GP / Manager Signature *", "Authorized Signatory", c2.c1, y, c2.cw);
    const rygp = y + 14 + 10 + 9;
    drawSignatureLine(page, fonts, "Date *", "March 11, 2026", c2.c2, rygp, c2.cw);
    y = drawTextField(page, fonts, "GP Print Name", "Morgan Stanley AIP Management LP", ML, y, USABLE_W, true);
    y -= 8;

    y = drawSectionBand(page, fonts, "NOTARY / WITNESS (if required by jurisdiction)", y);
    y = drawSignatureLine(page, fonts, "Witness Signature (optional)", "", c2.c1, y, c2.cw);
    const ryw = y + 14 + 10 + 9;
    drawSignatureLine(page, fonts, "Date (optional)", "", c2.c2, ryw, c2.cw);
    y = drawTextField(page, fonts, "Witness Print Name", "", ML, y, USABLE_W, false);
    y -= 12;

    page.drawText("* Required field.   Form version: CDRZ-TEST-2026.1", { x: ML, y, size: 7.5, font: italic, color: GREY });
  }

  // ── Save ──────────────────────────────────────────────────────────────────
  const pdfBytes = await pdfDoc.save();
  await fs.writeFile("test-form-mixed.pdf", pdfBytes);
  console.log("✓  Written: test-form-mixed.pdf  (15 pages)");
  console.log("");
  console.log("Fields intentionally LEFT EMPTY (should be flagged as incomplete):");
  console.log("  Page 1:  Legal/Beneficial Owner Name, Registered Name, Tax ID/EIN");
  console.log("  Page 2:  Postal/Zip Code, Title/Role, Phone Number");
  console.log("  Page 3:  Commitment Amount, Source of Investment Funds (none selected), Risk Tolerance (none selected)");
  console.log("  Page 4:  Qualified Purchaser Yes/No (unanswered), ERISA 12c conditional follow-up");
  console.log("  Page 5:  13b conditional follow-up (US Person triggered), Country of Tax Residence");
  console.log("  Page 6:  Country where wealth generated, 19a beneficial ownership follow-up");
  console.log("  Page 7:  Bank Name, Account Number, distribution conditional fields");
  console.log("  Page 8:  Signatory title, phone, signatory 2 fields, GP Name");
  console.log("  Page 9:  Table Q8/Q9/Q10 unanswered, LPA agreement checkbox");
  console.log("  Page 10: Compliance fields (optional - should NOT flag)");
  console.log("  Page 11: Total Net Worth");
  console.log("  Page 12: Notice Recipient Name, Address fields");
  console.log("  Page 13: Side letter description (38a triggered)");
  console.log("  Page 14: Data Privacy Consent checkbox");
  console.log("  Page 15: Investor Signature, Date, Title");
  console.log("");
  console.log("Fields intentionally FILLED (should NOT be flagged):");
  console.log("  Short Name, Jurisdiction (US radio), Domicile (Delaware), Entity Type (Partnership)");
  console.log("  Formation Date, Address, City, Email, Investment Amount, Capital Appreciation objective");
  console.log("  Accredited Investor basis, Investment Discretion entity, Print Name, GP Signature/Date");
  console.log("  All conditional fields where parent answer was 'No' (should not be flagged)");
}

generate().catch(err => { console.error(err); process.exit(1); });
