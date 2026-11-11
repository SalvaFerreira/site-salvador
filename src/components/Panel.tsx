import { useEffect, useRef } from "react";
import type { Project } from "./City";

export default function Panel({ project, onClose }: { project: Project; onClose: () => void }) {
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    heading.current?.focus();
  }, [project.slug]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <aside className="panel" aria-labelledby="panel-title">
      <button type="button" className="panel-close" onClick={onClose}>
        Close
      </button>
      <p className="panel-place">{project.place}</p>
      <h1 id="panel-title" ref={heading} tabIndex={-1}>
        {project.title}
      </h1>
      {project.stack.length > 0 && <p className="panel-stack">{project.stack.join(" · ")}</p>}
      {/* Rendered from the project's Markdown file at build time. */}
      <div className="panel-body" dangerouslySetInnerHTML={{ __html: project.html }} />
    </aside>
  );
}
