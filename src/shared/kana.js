// Kana labels and vowel grouping, shared across the app and both dashboards.
// Convention (see the confusion matrices): hiragana = the kana the user picks
// (button/column side), katakana = the sound the user heard (row side).

export const HIRAGANA = {
  sa: "さ", za: "ざ", sya: "しゃ", zya: "じゃ", tya: "ちゃ",
  si: "し", zi: "じ", ti: "ち",
  su: "す", zu: "ず", tu: "つ", syu: "しゅ", zyu: "じゅ", tyu: "ちゅ",
  so: "そ", zo: "ぞ", syo: "しょ", zyo: "じょ", tyo: "ちょ",
};

export const KATAKANA = {
  sa: "サ", za: "ザ", sya: "シャ", zya: "ジャ", tya: "チャ",
  si: "シ", zi: "ジ", ti: "チ",
  su: "ス", zu: "ズ", tu: "ツ", syu: "シュ", zyu: "ジュ", tyu: "チュ",
  so: "ソ", zo: "ゾ", syo: "ショ", zyo: "ジョ", tyo: "チョ",
};

// The 19 morae grouped by vowel row (option sets are always same-vowel).
export const VOWEL_GROUPS = {
  a: ["sa", "za", "sya", "zya", "tya"],
  i: ["si", "zi", "ti"],
  u: ["su", "zu", "tu", "syu", "zyu", "tyu"],
  o: ["so", "zo", "syo", "zyo", "tyo"],
};
