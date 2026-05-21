// 命令块列表 —— 跑完的命令按时间顺序堆叠在活动区 Canvas 上方。
//
// alt-screen 时由 `pane_leaf` 整个挂起本组件(TUI 全屏占 Canvas),所以这里
// 不需要自己判 alt-screen。Phase 3 不做虚拟列表:折叠后的块很轻,块数量真涨
// 到拖慢时再记 TODO.md。

import { For, type Component } from "solid-js";

import type { CommandBlock } from "../state/blocks";
import { BlockOne } from "./block_one";

export type BlockListProps = {
  blocks: CommandBlock[];
  fontFamily: string;
  fontSize: number;
  onToggleFold: (id: number) => void;
};

export const BlockList: Component<BlockListProps> = (props) => (
  <div style={{ flex: "0 0 auto" }}>
    <For each={props.blocks}>
      {(block) => (
        <BlockOne
          block={block}
          fontFamily={props.fontFamily}
          fontSize={props.fontSize}
          onToggleFold={() => props.onToggleFold(block.id)}
        />
      )}
    </For>
  </div>
);
