import { FeedId } from "../domain/value-objects/feed-id";

/**
 * Generates a random feed ID in the format noun1.noun2.XY
 * @returns A random feed ID string
 */
export function generateFeedId(): string {
  return FeedId.generate().value;
}
