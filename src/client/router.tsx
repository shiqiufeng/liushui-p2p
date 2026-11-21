import { createRootRoute, createRoute, createRouter, Outlet } from "@tanstack/react-router";
import Home from "./pages/Home";
import LocaleRedirect from "./pages/LocaleRedirect";
import NotFound from "./pages/NotFound";
import Group from "./pages/Group";
import Room from "./pages/Room";

const rootRoute = createRootRoute({ component: Outlet, notFoundComponent: NotFound });

const homeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: LocaleRedirect,
});

const englishHomeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/en",
  component: () => <Home locale="en" />,
});

const chineseHomeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/zh",
  component: () => <Home locale="zh" />,
});

const englishRoomRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/en/room/$roomId",
  component: () => {
    const { roomId } = englishRoomRoute.useParams();
    return <Room locale="en" roomId={roomId} />;
  },
  validateSearch: (search: Record<string, unknown>) => search,
});

const chineseRoomRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/zh/room/$roomId",
  component: () => {
    const { roomId } = chineseRoomRoute.useParams();
    return <Room locale="zh" roomId={roomId} />;
  },
  validateSearch: (search: Record<string, unknown>) => search,
});

const englishGroupLobbyRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/en/group",
  component: () => <Group locale="en" />,
});

const chineseGroupLobbyRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/zh/group",
  component: () => <Group locale="zh" />,
});

const englishGroupRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/en/group/$roomId",
  component: () => {
    const { roomId } = englishGroupRoute.useParams();
    return <Group locale="en" roomId={roomId} />;
  },
  validateSearch: (search: Record<string, unknown>) => search,
});

const chineseGroupRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/zh/group/$roomId",
  component: () => {
    const { roomId } = chineseGroupRoute.useParams();
    return <Group locale="zh" roomId={roomId} />;
  },
  validateSearch: (search: Record<string, unknown>) => search,
});

const routeTree = rootRoute.addChildren([
  homeRoute,
  englishHomeRoute,
  chineseHomeRoute,
  englishRoomRoute,
  chineseRoomRoute,
  englishGroupLobbyRoute,
  chineseGroupLobbyRoute,
  englishGroupRoute,
  chineseGroupRoute,
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
