import {describe, expect, it} from "vitest";
import {workerFailureReason} from "../server/execution";

describe("worker failure reasons", () => {
  it("reads the node and the exception out of ComfyUI's messages", () => {
    const entry = {
      status: {
        status_str: "error",
        messages: [
          ["execution_start", {prompt_id: "p"}],
          ["execution_error", {node_id: "12", node_type: "KSampler", exception_type: "RuntimeError", exception_message: "CUDA out of memory. Tried to allocate 2.00 GiB"}],
        ],
      },
    };
    expect(workerFailureReason(entry)).toBe("Worker failed at node 12 (KSampler): CUDA out of memory. Tried to allocate 2.00 GiB");
  });

  it("keeps a long message readable by collapsing whitespace and cutting at 300", () => {
    const entry = {status: {status_str: "error", messages: [["execution_error", {node_id: "3", exception_message: `${"detail ".repeat(80)}\n`}]]}};
    const reason = workerFailureReason(entry)!;
    expect(reason.length).toBeLessThanOrEqual(300);
    expect(reason).not.toContain("\n");
  });

  it("falls back to the exception type, then to the node alone", () => {
    expect(workerFailureReason({status: {messages: [["execution_error", {node_type: "VAEDecode", exception_type: "ValueError"}]]}})).toBe("Worker failed: ValueError");
    expect(workerFailureReason({status: {messages: [["execution_error", {node_id: "7"}]]}})).toBe("Worker failed at node 7: no message from the worker");
  });

  it("returns nothing when the worker gave no error entry, so the caller keeps its generic sentence", () => {
    expect(workerFailureReason({status: {messages: [["execution_start", {}]]}})).toBeUndefined();
    expect(workerFailureReason({status: {}})).toBeUndefined();
    expect(workerFailureReason({})).toBeUndefined();
    expect(workerFailureReason({status: {messages: ["not-an-array"]}})).toBeUndefined();
  });
});
