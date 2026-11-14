/*
 * Hand the grey-block clip of one shot to the AI video flow. The clip is
 * uploaded into the project (the server already validates and probes video
 * uploads), converted to the delivery MP4 when the server can encode it, and
 * its asset id goes to the Make it real screen through the callback the app
 * shell passes down.
 */

const jsonError = async (response: Response): Promise<string> => {
  try {
    const body = (await response.json()) as {error?: string};
    return body?.error ?? `Request failed (${response.status})`;
  } catch {
    return `Request failed (${response.status})`;
  }
};

/**
 * Upload deterministically rendered JPEG frames; the server encodes them to an
 * H.264 MP4 asset and returns its id. This replaces MediaRecorder for shots.
 */
export async function uploadBlockoutClip(
  workspaceId: string,
  projectId: string | undefined,
  clip: {frames: string[]; fps: number; name?: string},
): Promise<{id: string; width?: number; height?: number; durationSeconds?: number; frames?: number}> {
  const response = await fetch(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/blockout-clips`, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    credentials: "same-origin",
    body: JSON.stringify({
      fps: clip.fps,
      frames: clip.frames,
      ...(projectId ? {projectId} : {}),
      ...(clip.name ? {name: clip.name} : {}),
    }),
    signal: AbortSignal.timeout(300_000),
  });
  if (!response.ok) throw new Error(await jsonError(response));
  const asset = (await response.json()) as {id?: string};
  if (!asset?.id) throw new Error("The server did not return an asset id.");
  return asset as {id: string};
}

/** Upload a video blob as a project asset and return its id. */
export async function uploadGreyClip(workspaceId: string, projectId: string | undefined, blob: Blob, name: string): Promise<string> {
  const query = new URLSearchParams({kind: "video"});
  if (projectId) query.set("projectId", projectId);
  const form = new FormData();
  form.append("file", blob, name);
  const response = await fetch(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/assets?${query.toString()}`, {
    method: "POST",
    body: form,
    credentials: "same-origin",
  });
  if (!response.ok) throw new Error(await jsonError(response));
  const asset = (await response.json()) as {id?: string};
  if (!asset?.id) throw new Error("The server did not return an asset id.");
  return asset.id;
}

/**
 * The H3 previs flow takes a normal video input; encode the recording to the
 * server's 720p24 MP4 when FFmpeg is available and keep the original asset
 * otherwise, so the handoff never loses the clip.
 */
export async function deliveryMp4(workspaceId: string, assetId: string): Promise<string> {
  try {
    const response = await fetch(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/assets/${encodeURIComponent(assetId)}/exports`, {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({profileId: "mp4-h264-720p24"}),
      credentials: "same-origin",
      signal: AbortSignal.timeout(180_000),
    });
    if (!response.ok) return assetId;
    const exported = (await response.json()) as {id?: string};
    return exported?.id ?? assetId;
  } catch {
    return assetId;
  }
}
