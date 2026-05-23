// Ctrl/Cmd+C 在终端里有双重语义:有终端选区时复制,否则 Ctrl+C 发 SIGINT。

export function isPlainCopyShortcut(e: KeyboardEvent): boolean {
  return (
    (e.ctrlKey || e.metaKey) &&
    !e.shiftKey &&
    !e.altKey &&
    (e.key === "c" || e.key === "C")
  );
}

export async function copyTextToClipboard(text: string): Promise<void> {
  if (text.length === 0) return;

  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Tauri/WebKitGTK dev builds can deny Clipboard API; textarea fallback keeps
      // the shortcut usable without sending Ctrl+C to the PTY.
    }
  }

  copyWithTextarea(text);
}

function copyWithTextarea(text: string): void {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  Object.assign(textarea.style, {
    position: "fixed",
    top: "-1000px",
    left: "0",
    width: "1px",
    height: "1px",
    opacity: "0",
  });
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  try {
    document.execCommand("copy");
  } finally {
    textarea.remove();
  }
}
