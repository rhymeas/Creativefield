import {useState} from "react";
import {Button, Dialog} from "../ds";

const WELCOME_KEY = "creativefield.welcome.v1";

/** A short introduction, shown once per browser and dismissible at any time. */
export function Welcome() {
  const [open, setOpen] = useState(() => {
    try { return localStorage.getItem(WELCOME_KEY) !== "dismissed"; }
    catch { return false; }
  });
  const close = () => {
    try { localStorage.setItem(WELCOME_KEY, "dismissed"); } catch { /* storage may be unavailable */ }
    setOpen(false);
  };
  return <Dialog open={open} title="Welcome to CreativeField" onClose={close} footer={<Button variant="primary" onClick={close}>Let's create</Button>}>
    <p>Every idea starts somewhere. Make a picture, shape a scene, or bring a moment to life.</p>
    <p>Choose a tool, add your prompt or media, and explore. Local generation needs a connected ComfyUI worker and the right models.</p>
  </Dialog>;
}
