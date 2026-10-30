/**
 * Who a screen is talking to, and the words that change with it.
 *
 * The intended use today is one person on their own computer: the server says so
 * (`config.localSingleUser` -> `user.localSingleUser`). That person has every role and nobody
 * to ask, so no screen may call them an administrator, send them to a team, or offer an
 * invitation. A shared workspace keeps today's wording.
 */
export type Audience = "solo" | "team";

export function audienceOf(user: { localSingleUser?: boolean } | null | undefined): Audience {
  return user?.localSingleUser ? "solo" : "team";
}

/** The dialog that holds workers, providers, members and keys. One person has no team to name. */
export const settingsLabel = (audience: Audience) => audience === "solo" ? "Settings" : "Team settings";

/** A workspace that does not exist: a solo user cannot ask anyone for an invitation. */
export const noWorkspaceText = (audience: Audience) => audience === "solo"
  ? "This computer has no workspace yet. Restart CreativeField once to create it."
  : "Ask a workspace administrator for an invitation.";

/** The facts about the workspace. One person on their own PC has no role to read; a shared one keeps it. */
export function workspaceFacts(audience: Audience, workspace: { name: string; role: string }): string[] {
  return audience === "solo" ? [workspace.name] : [workspace.name, workspace.role];
}

/** The book button that opens the place where ComfyUI is connected. */
export const connectComfyAction = (audience: Audience) => audience === "solo" ? "Settings" : "Worker settings";

/**
 * Setup step 2: connect ComfyUI. The app performs this step (add the address, then check it), so the
 * copy never sends the person to start or probe something on their own before coming back.
 */
export function comfyStep(audience: Audience, connected: boolean): { title: string; text: string } {
  if (audience === "solo") {
    return connected
      ? { title: "2. ComfyUI connected", text: "ComfyUI answered from this computer; its models and nodes are in Models." }
      : { title: "2. Connect ComfyUI", text: "Add ComfyUI's address and check it; its models and nodes then appear in Models." };
  }
  return connected
    ? { title: "2. Local worker connected", text: "A ComfyUI worker is connected and answering; its models and nodes are in Models." }
    : { title: "2. Connect a local worker", text: "A workspace admin connects and probes ComfyUI workers. Ask your admin if none is ready." };
}
