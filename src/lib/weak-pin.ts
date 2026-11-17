const BLOCKED = new Set([
  "1234",
  "0000",
  "1111",
  "2222",
  "3333",
  "4444",
  "5555",
  "6666",
  "7777",
  "8888",
  "9999",
  "1212",
  "1004",
  "2000",
  "2001",
  "2580",
  "0852",
  "123456",
  "654321",
  "123123",
  "112233",
  "121212",
]);

// One policy for the setup screen, the server and the parent keypad.
export const PIN_MIN_LENGTH = 4;
export const PIN_MAX_LENGTH = 8;

export function pinProblem(pin: string): string | null {
  if (!/^\d{4,8}$/.test(pin)) {
    return "Use 4 to 8 digits.";
  }
  if (BLOCKED.has(pin) || /^(\d)\1+$/.test(pin)) {
    return "That PIN is too easy to guess. Pick something less obvious.";
  }
  const digits = [...pin].map(Number);
  let ascending = true;
  let descending = true;
  for (let index = 1; index < digits.length; index += 1) {
    if (digits[index] !== digits[index - 1] + 1) ascending = false;
    if (digits[index] !== digits[index - 1] - 1) descending = false;
  }
  if (ascending || descending) {
    return "That PIN is a straight sequence. Pick something less obvious.";
  }
  return null;
}
