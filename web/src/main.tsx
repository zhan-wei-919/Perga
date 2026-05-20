/* @refresh reload */
import { render } from "solid-js/web";
import { App } from "./ui/app";

const root = document.getElementById("root");
if (!root) {
  throw new Error("missing #root mount node");
}
render(() => <App />, root);
