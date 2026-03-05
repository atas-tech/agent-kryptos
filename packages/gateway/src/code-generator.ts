const ADJECTIVES = ["BLUE", "GREEN", "SILVER", "BOLD"];
const NOUNS = ["FOX", "RIVER", "PINE", "FALCON"];

export function generateCode(): string {
  const adjective = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  const num = Math.floor(Math.random() * 100)
    .toString()
    .padStart(2, "0");
  return `${adjective}-${noun}-${num}`;
}
