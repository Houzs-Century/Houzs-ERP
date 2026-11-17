const MALAYSIA_PREFIX = '+60';
const EIGHT_DIGIT_SUBSCRIBER_MOBILE_PREFIXES = ['11', '15'];
const SEVEN_DIGIT_SUBSCRIBER_MOBILE_LENGTH = 9;
const EIGHT_DIGIT_SUBSCRIBER_MOBILE_LENGTH = 10;
const LANDLINE_LENGTHS = [8, 9];

function expectedNationalLengths(nationalNumber: string): number[] {
  if (!nationalNumber.startsWith('1')) return LANDLINE_LENGTHS;
  const isEightDigitSubscriber = EIGHT_DIGIT_SUBSCRIBER_MOBILE_PREFIXES.some((prefix) => nationalNumber.startsWith(prefix));
  return [isEightDigitSubscriber ? EIGHT_DIGIT_SUBSCRIBER_MOBILE_LENGTH : SEVEN_DIGIT_SUBSCRIBER_MOBILE_LENGTH];
}

export function hasUnexpectedDigitCount(phone: string): boolean {
  if (!phone.startsWith(MALAYSIA_PREFIX)) return false;
  const nationalNumber = phone.slice(MALAYSIA_PREFIX.length);
  return !expectedNationalLengths(nationalNumber).includes(nationalNumber.length);
}

function localForm(phone: string): string {
  return `0${phone.slice(MALAYSIA_PREFIX.length)}`;
}

export function phoneDigitCountWarnings(phones: string[]): string[] {
  return phones
    .filter(hasUnexpectedDigitCount)
    .map((phone) => `Check phone ${localForm(phone)} against the slip: it looks like a digit was dropped or doubled.`);
}
