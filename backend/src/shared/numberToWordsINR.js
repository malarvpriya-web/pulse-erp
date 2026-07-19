// numberToWordsINR.js — convert a number to Indian-format words (Rupees & Paise).
// e.g. 125000.50 → "One Lakh Twenty Five Thousand Rupees and Fifty Paise Only"

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine',
  'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen',
  'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function twoDigits(n) {
  if (n < 20) return ONES[n];
  const t = Math.floor(n / 10);
  const o = n % 10;
  return TENS[t] + (o ? ' ' + ONES[o] : '');
}

function threeDigits(n) {
  const h = Math.floor(n / 100);
  const rest = n % 100;
  let s = '';
  if (h) s += ONES[h] + ' Hundred';
  if (rest) s += (s ? ' ' : '') + twoDigits(rest);
  return s;
}

// Convert the integer part using the Indian numbering system (crore/lakh/thousand)
function integerToWords(num) {
  if (num === 0) return 'Zero';
  let words = '';
  const crore = Math.floor(num / 10000000); num %= 10000000;
  const lakh  = Math.floor(num / 100000);   num %= 100000;
  const thousand = Math.floor(num / 1000);  num %= 1000;
  const rest = num;

  if (crore)    words += threeDigits(crore) + ' Crore ';
  if (lakh)     words += twoDigits(lakh) + ' Lakh ';
  if (thousand) words += twoDigits(thousand) + ' Thousand ';
  if (rest)     words += threeDigits(rest);
  return words.trim();
}

export function numberToWordsINR(value) {
  const amount = Math.abs(Math.round((parseFloat(value) || 0) * 100) / 100);
  const rupees = Math.floor(amount);
  const paise = Math.round((amount - rupees) * 100);

  let words = integerToWords(rupees) + ' Rupees';
  if (paise > 0) words += ' and ' + twoDigits(paise) + ' Paise';
  words += ' Only';
  return words;
}

export default numberToWordsINR;
