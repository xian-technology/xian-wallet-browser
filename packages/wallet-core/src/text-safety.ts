// Characters that render as nothing or reorder surrounding text, so a reviewer
// could read something other than the bytes being signed. Tab, newline and
// carriage return stay as ordinary layout.
const HIDDEN_CHARACTER =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F­؜ᅟᅠ᠎​-‏‪-‮⁠-⁤⁦-⁯ㅤ﻿ﾠ￹-￻\u{E0000}-\u{E007F}]/gu;

function codePointLabel(character: string): string {
  const codePoint = character.codePointAt(0) ?? 0;
  return `[U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}]`;
}

/** Replace hidden characters with visible [U+XXXX] markers. */
export function revealHiddenCharacters(text: string): string {
  return text.replace(HIDDEN_CHARACTER, codePointLabel);
}

export const HIDDEN_CHARACTERS_WARNING =
  "This request contains invisible or text-direction characters. They are shown as [U+XXXX] markers.";
