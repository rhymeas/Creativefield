/*
 * The Film Studio module registry. A module is one working mode of the studio
 * (blocking, coverage, and later analysis or generation). Adding a module is
 * one line here plus its component; the shell shows a mode switch only when
 * there is more than one, so the workspace never offers an empty tab.
 */
import type {ComponentType} from "react";
import type {FilmStudioModuleId, FilmStudioSession} from "./session";
import {BlockingModule} from "./stage/BlockingModule";
import {GeometryModule} from "./stage/GeometryModule";
import {ShotsModule} from "./stage/ShotsModule";

export type FilmStudioModuleProps = {session: FilmStudioSession};

export type FilmStudioModule = {id: FilmStudioModuleId; title: string; Component: ComponentType<FilmStudioModuleProps>};

export const FILM_STUDIO_MODULES: FilmStudioModule[] = [
  {id: "blocking", title: "Blocking", Component: BlockingModule},
  {id: "shots", title: "Shots", Component: ShotsModule},
  {id: "geometry", title: "Geometry", Component: GeometryModule},
];
