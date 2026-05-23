// 终端字体预设。
//
// 这轮只做 Linux/system font stack,不打包字体文件。不存在的字体由浏览器按
// font-family fallback 跳过;终端 cell 宽度仍由实际命中的 Latin monospace 测得。

export type FontId =
  | "default"
  | "jetbrains"
  | "compact"
  | "liberation"
  | "cjk";

export type FontPreset = {
  name: string;
  primary: string;
  description: string;
  sampleLines: string[];
  family: string;
};

export const FONT_IDS: FontId[] = [
  "default",
  "jetbrains",
  "compact",
  "liberation",
  "cjk",
];

export const FONT_PRESETS: Record<FontId, FontPreset> = {
  default: {
    name: "DejaVu Sans Mono",
    primary: "DejaVu Sans Mono",
    description: "稳妥、宽松,多数 Linux 发行版默认可用。",
    sampleLines: [
      "zhanwei@host:~/project $ ls -la",
      "0O 1l Il | [] {} -> != ==",
      "中文路径/项目 12345",
    ],
    family:
      '"DejaVu Sans Mono", "Liberation Mono", "JetBrainsMono Nerd Font Mono", "Noto Sans Mono CJK SC", "WenQuanYi Zen Hei Mono", Menlo, Consolas, monospace',
  },
  jetbrains: {
    name: "JetBrains Mono",
    primary: "JetBrainsMono Nerd Font Mono",
    description: "字形更现代,符号和数字辨识度更强。",
    sampleLines: [
      "zhanwei@host:~/project $ pnpm test",
      "0O 1l Il | [] {} -> != ==",
      "λ fn(x) => x + 1  中文",
    ],
    family:
      '"JetBrainsMono Nerd Font Mono", "JetBrainsMonoNL Nerd Font Mono", "JetBrainsMono Nerd Font", "DejaVu Sans Mono", "Noto Sans Mono CJK SC", monospace',
  },
  compact: {
    name: "Ubuntu Mono",
    primary: "Ubuntu Mono",
    description: "更窄、更有个性,同屏能放下更多列。",
    sampleLines: [
      "zhanwei@host:~/project $ cargo check",
      "0O 1l Il | [] {} -> != ==",
      "apps    key    project",
    ],
    family:
      '"Ubuntu Mono", "Nimbus Mono PS", "Liberation Mono", "DejaVu Sans Mono", "Noto Sans Mono CJK SC", monospace',
  },
  liberation: {
    name: "Liberation Mono",
    primary: "Liberation Mono",
    description: "接近传统终端字体,ASCII 对齐稳定。",
    sampleLines: [
      "zhanwei@host:~/project $ git status",
      "0O 1l Il | [] {} -> != ==",
      "src    docs    crates",
    ],
    family:
      '"Liberation Mono", "Nimbus Mono PS", "Courier New", "Noto Sans Mono CJK SC", monospace',
  },
  cjk: {
    name: "Noto Sans Mono CJK SC",
    primary: "Noto Sans Mono CJK SC",
    description: "中文优先,中英文混排行距和宽度更稳。",
    sampleLines: [
      "zhanwei@host:~/项目 $ ls",
      "公共  图片  音乐  Applications",
      "0O 1l Il | [] {} -> != ==",
    ],
    family:
      '"Noto Sans Mono CJK SC", "WenQuanYi Zen Hei Mono", "DejaVu Sans Mono", "Liberation Mono", monospace',
  },
};

export function fontFamilyFor(id: FontId): string {
  return FONT_PRESETS[id].family;
}
