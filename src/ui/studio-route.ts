import { useEffect, useState } from "react";

export type StudioRoute = "video" | "motion" | "library" | "catalogue";

const ROUTE_HASH: Record<StudioRoute, `#${StudioRoute}`> = {
  video: "#video",
  motion: "#motion",
  library: "#library",
  catalogue: "#catalogue",
};

export function studioRouteFromHash(hash: string): StudioRoute {
  if (hash === ROUTE_HASH.motion) return "motion";
  if (hash === ROUTE_HASH.library) return "library";
  if (hash === ROUTE_HASH.catalogue) return "catalogue";
  return "video";
}

export function studioRouteHash(route: StudioRoute): `#${StudioRoute}` {
  return ROUTE_HASH[route];
}

/** The part of a video hash after the section: `#video/camera` names one workflow. */
export function videoHashPart(hash: string): string | undefined {
  const [section, part] = hash.replace(/^#/, "").split("/");
  return section === "video" && part ? part : undefined;
}

/** The address of one workflow in the video screen, so reload and back keep the choice. */
export function videoWorkflowHash(id: string): string {
  return `#video/${id}`;
}

export function navigateStudio(route: StudioRoute) {
  const next = studioRouteHash(route);
  if (location.hash === next) return;
  location.hash = next;
}

/**
 * The hash is the durable destination contract. Keeping the Studio component mounted means local
 * files, draft prompts, the ComfyUI connection and its job subscription survive navigation.
 */
export function useStudioRoute(): StudioRoute {
  const [route, setRoute] = useState<StudioRoute>(() => studioRouteFromHash(location.hash));

  useEffect(() => {
    const read = () => setRoute(studioRouteFromHash(location.hash));
    addEventListener("hashchange", read);

    if (!Object.values(ROUTE_HASH).includes(location.hash as `#${StudioRoute}`) && location.hash !== "#ds") {
      history.replaceState(null, "", `${location.pathname}${location.search}${ROUTE_HASH.video}`);
    }

    return () => removeEventListener("hashchange", read);
  }, []);

  return route;
}
