import fs from 'node:fs';
import path from 'node:path';

const parseCSV = (contents) => {
  // Enforce consistent newline endings
  contents = contents.replace(/\r\n/g, '\n');

  const rows = [];
  let currentRow = [''];
  let inQuote = false;

  let i = 0;
  while (i < contents.length) {
    const character = contents[i];
    if (inQuote) {
      if (character === '"') {
        const nextCharacter = contents[i + 1];
        if (nextCharacter === '"') {
          // Literal quote character
          currentRow[currentRow.length - 1] += '"';
          i += 2;
        } else {
          inQuote = false;
          i++;
        }
      } else {
        // Literal quoted text
        currentRow[currentRow.length - 1] += character
        i++;
      }
    } else {
      if (character === ',') {
        // Start a new column
        currentRow.push('');
        i++;

        if (contents[i] === '"') {
          inQuote = true;
          i++;
        }
      } else if (character === '\n') {
        // Start a new row
        rows.push(currentRow);
        currentRow = [''];
        i++;
      } else {
        currentRow[currentRow.length - 1] += character
        i++;
      }
    }
  }

  // Don't forget to record the last row, if it exists
  if (currentRow.length) {
    rows.push(currentRow);
  }

  return rows;
};

const generateCSV = (rows) => {
  const result = [];
  for (const row of rows) {
    const escapedRow = row.map(item => {
      if (item.includes('\n') || item.includes(',')) {
        return `"${item.replace(/"/g, '""')}"`;
      }
      return item;
    });
    result.push(escapedRow.join(','));
  }
  return result.join('\n');
};

const generateStoreListings = (rows) => {
  // CSV header: Field, ID, Type (Type), default, en-us, other locales...
  // NitroBolt only maintains the English Store listing for now.
  return rows.map(row => row.slice(0, 5));
};

const csvRows = parseCSV(fs.readFileSync(path.join(import.meta.dirname, 'from-microsoft.csv'), 'utf8'));
const parsedStoreListings = generateStoreListings(csvRows);
fs.writeFileSync('import-to-microsoft.csv', generateCSV(parsedStoreListings));
