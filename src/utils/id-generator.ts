import { nouns } from "../data/nouns";

/**
 * Generates a random feed ID in the format noun1.noun2.XY
 * @returns A random feed ID string
 */
export function generateFeedId(): string {
  // Select two random nouns
  const noun1 = nouns[Math.floor(Math.random() * nouns.length)];
  const noun2 = nouns[Math.floor(Math.random() * nouns.length)];

  // Generate a random 2-digit number between 10 and 99
  const number = Math.floor(Math.random() * 90) + 10;

  // Combine to create the ID with dots as separators
  return `${noun1}.${noun2}.${number}`;
}
