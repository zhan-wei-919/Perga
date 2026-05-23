// 终端字体预设。
//
// 这轮只做 Linux/system font stack,不打包字体文件。不存在的字体由浏览器按
// font-family fallback 跳过;终端 cell 宽度仍由实际命中的 Latin monospace 测得。

export type FontId = "default" | "compact" | "cjk";

export type FontPreset = {
  family: string;
};

export const FONT_IDS: FontId[] = ["default", "compact", "cjk"];

export const FONT_PRESETS: Record<FontId, FontPreset> = {
  default: {
    family:
      '"DejaVu Sans Mono", "Liberation Mono", "JetBrainsMono Nerd Font Mono", "Noto Sans Mono CJK SC", "WenQuanYi Zen Hei Mono", Menlo, Consolas, monospace',
  },
  compact: {
    family:
      '"Ubuntu Mono", "Nimbus Mono PS", "Liberation Mono", "DejaVu Sans Mono", "Noto Sans Mono CJK SC", monospace',
  },
  cjk: {
    family:
      '"Noto Sans Mono CJK SC", "WenQuanYi Zen Hei Mono", "DejaVu Sans Mono", "Liberation Mono", monospace',
  },
};

export function fontFamilyFor(id: FontId): string {
  return FONT_PRESETS[id].family;
}
