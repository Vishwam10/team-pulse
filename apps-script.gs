/**
 * Team Pulse — Apps Script web app for sheet persistence.
 *
 * Purpose: thin HTTP wrapper around SpreadsheetApp so that the Claude Code
 * digest prompt can append richly-formatted rows without GCP service accounts
 * or OAuth tokens.
 *
 * Deployment (one-time):
 *   1. Open the target Google Sheet (the one whose ID is in config.json)
 *   2. Extensions → Apps Script
 *   3. Paste this file's contents into Code.gs (replace any existing code)
 *   4. Project Settings → Script Properties → ensure SECRET is set
 *   5. Deploy → Manage deployments → Edit (pencil) on the existing deployment →
 *      Version: New version → Deploy. This keeps the SAME web app URL.
 *      (If you create a fresh deployment instead, you'll get a new URL and need
 *      to update config.json.)
 *
 * Endpoints:
 *   POST {url}            -> append a row to the active spreadsheet
 *     Body: { secret, row: [...], sheet_name?: "Sheet1" }
 *     Column 1 (date) is set as a plain value (Sheets coerces date-like strings).
 *     Columns 2..N are parsed as extended-markdown and stored as RichTextValues.
 *
 *   GET  {url}?secret=...&column=A&sheet_name=Sheet1 -> read one column
 *
 * Extended markdown subset (only applied to columns 2..N):
 *   **bold**             → bold
 *   *italic*             → italic     (single underscore _ is NOT italic — would
 *                                       false-trigger on identifiers like pr_no_reviews)
 *   __underline__        → underline  (double underscore — rare in identifiers)
 *   ~~strikethrough~~    → strikethrough
 *   [red]text[/red]      → red color (also green, blue, gray)
 *   [big]text[/big]      → 14pt font size
 *   [text](url)          → hyperlink (clickable in cell)
 */

const COLOR_MAP = {
  'red':   '#cc0000',
  'green': '#1e7a1e',
  'blue':  '#1e4eaf',
  'gray':  '#6b6b6b'
};
const SIZE_MAP = {
  'big': 14
};

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    if (!isAuthorized(body.secret)) return jsonOut({ok: false, error: 'unauthorized'});
    if (!Array.isArray(body.row)) return jsonOut({ok: false, error: 'row must be an array'});

    const sheet = pickSheet(body.sheet_name);
    if (!sheet) return jsonOut({ok: false, error: 'sheet_not_found', sheet_name: body.sheet_name});

    const nextRow = sheet.getLastRow() + 1;
    const numCols = body.row.length;

    // Column 1 (date): parse string → Date, store typed, apply human-readable display format.
    // Storing as Date (not string) preserves sortability and date-function queries.
    // Number format renders in the spreadsheet's locale/timezone (e.g. "03 May 2026, 06:17 PM").
    let dateInput = body.row[0];
    let dateValue = dateInput;
    if (typeof dateInput === 'string') {
      const parsed = new Date(dateInput);
      if (!isNaN(parsed.getTime())) dateValue = parsed;
    }
    const dateCell = sheet.getRange(nextRow, 1);
    dateCell.setValue(dateValue);
    dateCell.setNumberFormat('dd mmm yyyy, hh:mm AM/PM');

    // Columns 2..N: parse extended-markdown into RichTextValues.
    if (numCols > 1) {
      const richValues = body.row.slice(1).map(function(md) {
        return mdToRichText(String(md == null ? '' : md));
      });
      const range = sheet.getRange(nextRow, 2, 1, numCols - 1);
      range.setRichTextValues([richValues]);
      range.setVerticalAlignment('top').setWrap(true);
    }

    return jsonOut({ok: true, last_row: sheet.getLastRow()});
  } catch (err) {
    return jsonOut({ok: false, error: 'exception', detail: err.toString()});
  }
}

function doGet(e) {
  try {
    if (!isAuthorized(e.parameter.secret)) return jsonOut({ok: false, error: 'unauthorized'});

    const sheet = pickSheet(e.parameter.sheet_name);
    if (!sheet) return jsonOut({ok: false, error: 'sheet_not_found', sheet_name: e.parameter.sheet_name});

    const column = e.parameter.column || 'A';
    const values = sheet.getRange(column + ':' + column).getValues().flat().filter(function(v) { return v !== ''; });
    return jsonOut({ok: true, column: column, values: values, last_row: sheet.getLastRow()});
  } catch (err) {
    return jsonOut({ok: false, error: 'exception', detail: err.toString()});
  }
}

function isAuthorized(secret) {
  const expected = PropertiesService.getScriptProperties().getProperty('SECRET');
  return Boolean(expected) && secret === expected;
}

function pickSheet(name) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  return name ? ss.getSheetByName(name) : ss.getSheets()[0];
}

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
                       .setMimeType(ContentService.MimeType.JSON);
}

/**
 * Parse extended-markdown text into a Google Sheets RichTextValue.
 * Stack-based parser; supports nested formatting (e.g. bold inside red).
 */
function mdToRichText(input) {
  if (input == null) input = '';

  let plain = '';
  const segs = [];
  const stack = [];

  function isActive(type) {
    for (let i = 0; i < stack.length; i++) if (stack[i].type === type) return true;
    return false;
  }
  function valueFor(type) {
    for (let i = stack.length - 1; i >= 0; i--) if (stack[i].type === type) return stack[i].value;
    return null;
  }
  function popType(type) {
    for (let i = stack.length - 1; i >= 0; i--) {
      if (stack[i].type === type) { stack.splice(i, 1); return; }
    }
  }
  function attrs() {
    return {
      bold:      isActive('bold'),
      italic:    isActive('italic'),
      underline: isActive('underline'),
      strike:    isActive('strike'),
      color:     valueFor('color'),
      size:      valueFor('size')
    };
  }

  let segStart = 0;
  function flushAt(pos) {
    if (pos > segStart) {
      segs.push({start: segStart, end: pos, attrs: attrs()});
      segStart = pos;
    }
  }

  let i = 0;
  while (i < input.length) {
    const rest = input.substring(i);
    let consumed = 0, op = null;

    if (rest.substring(0, 2) === '**')      { op = ['toggle', 'bold'];      consumed = 2; }
    else if (rest.substring(0, 2) === '__') { op = ['toggle', 'underline']; consumed = 2; }
    else if (rest.substring(0, 2) === '~~') { op = ['toggle', 'strike'];    consumed = 2; }
    else if (rest[0] === '*') { op = ['toggle', 'italic']; consumed = 1; }
    // Note: single underscore is intentionally NOT italic — would false-trigger on
    // identifiers like pr_no_reviews, jira_account_id, simulated_blocker, etc.
    else {
      const openMatch = rest.match(/^\[(red|green|blue|gray|big)\]/);
      if (openMatch) {
        const tag = openMatch[1];
        op = SIZE_MAP[tag]
          ? ['push', 'size',  SIZE_MAP[tag]]
          : ['push', 'color', COLOR_MAP[tag]];
        consumed = openMatch[0].length;
      } else {
        const closeMatch = rest.match(/^\[\/(red|green|blue|gray|big)\]/);
        if (closeMatch) {
          const tag = closeMatch[1];
          op = SIZE_MAP[tag] ? ['pop', 'size'] : ['pop', 'color'];
          consumed = closeMatch[0].length;
        } else {
          // Markdown link: [text](url) — atomic emit, not a stack toggle.
          // Note: link match runs *after* color tag matches, so [red] is treated
          // as a color tag (no `(...)` after) rather than a link.
          const linkMatch = rest.match(/^\[([^\]]+)\]\(([^)]+)\)/);
          if (linkMatch) {
            op = ['emit_link', linkMatch[1], linkMatch[2]];
            consumed = linkMatch[0].length;
          }
        }
      }
    }

    if (op) {
      flushAt(plain.length);
      const action = op[0], type = op[1], value = op[2];
      if (action === 'toggle') {
        if (isActive(type)) popType(type); else stack.push({type: type});
      } else if (action === 'push') {
        stack.push({type: type, value: value});
      } else if (action === 'pop') {
        popType(type);
      } else if (action === 'emit_link') {
        // type = link text, value = link URL
        const linkSegStart = plain.length;
        plain += type;
        const linkAttrs = attrs();
        linkAttrs.link = value;
        segs.push({start: linkSegStart, end: plain.length, attrs: linkAttrs});
        segStart = plain.length;
      }
      i += consumed;
    } else {
      plain += input[i];
      i++;
    }
  }
  flushAt(plain.length);

  const builder = SpreadsheetApp.newRichTextValue().setText(plain);
  segs.forEach(function(seg) {
    const a = seg.attrs;

    // Apply text style (bold/italic/underline/strike/color/size) if any are set.
    if (a.bold || a.italic || a.underline || a.strike || a.color || a.size) {
      const sb = SpreadsheetApp.newTextStyle();
      if (a.bold)      sb.setBold(true);
      if (a.italic)    sb.setItalic(true);
      if (a.underline) sb.setUnderline(true);
      if (a.strike)    sb.setStrikethrough(true);
      if (a.color)     sb.setForegroundColor(a.color);
      if (a.size)      sb.setFontSize(a.size);
      builder.setTextStyle(seg.start, seg.end, sb.build());
    }

    // Apply hyperlink (independent of text style; can coexist).
    if (a.link) {
      builder.setLinkUrl(seg.start, seg.end, a.link);
    }
  });
  return builder.build();
}
