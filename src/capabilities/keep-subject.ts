/** A looked-up clip is restyled from its edges. Edges carry outline and motion, never a face, hair or
 *  clothes, so without these words the model reads the prompt as a fresh scene and invents a new person
 *  to stand in it. The clause names what stays, and leaves only the place and the light free. */
export const KEEP_SOURCE_SUBJECT =
  "Keep the same person from the clip: same face, same hair, same clothes and same pose. Only the place and the light change.";

/** The person's own words first, then what has to stay: a clip with no words still needs the clause. */
export function keepSourceSubjectPrompt(words: string): string {
  const text = words.trim();
  return text ? `${text}\n\n${KEEP_SOURCE_SUBJECT}` : KEEP_SOURCE_SUBJECT;
}
