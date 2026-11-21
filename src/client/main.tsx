import { RouterProvider } from "@tanstack/react-router";
import { createRoot } from "react-dom/client";
import { GlobalAmbientBackground } from "./components/GlobalAmbientBackground";
import { GlobalScrollbars } from "./components/GlobalScrollbars";
import { ThemeProvider } from "./components/theme";
import { router } from "./router";
import "./styles.css";

document.documentElement.classList.add("dark");
document.documentElement.style.colorScheme = "dark";

createRoot(document.getElementById("root")!).render(
  <ThemeProvider>
    <GlobalScrollbars />
    <GlobalAmbientBackground />
    <div className="liushui-viewport relative z-10">
      <RouterProvider router={router} />
    </div>
  </ThemeProvider>,
);
