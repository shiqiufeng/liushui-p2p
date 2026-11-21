import { useEffect, type ReactNode } from "react";

export default function Layout({ children, title = "流水P2P - 点对点文件传输" }: { children: ReactNode; title?: string }) {
  useEffect(() => {
    document.title = title;
  }, [title]);

  return (
    <main className="liushui-viewport box-border overflow-hidden text-slate-100">{children}</main>
  );
}
