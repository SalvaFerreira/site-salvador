import { useEffect, useRef } from "react";
import { type Category, type Project, type Stop } from "./City";

const CATEGORY_NAME: Record<Category, string> = {
  job: "Work",
  education: "Education",
  personal: "Personal project",
};

interface Tour {
  position: number;
  total: number;
  onPrevious?: () => void;
  onNext?: () => void;
}

interface Props {
  stop: Stop;
  /** The stop's projects, in reading order: one, or several that share a place. */
  projects: Project[];
  /** Slug of the project the address points at. */
  active: string;
  onClose: () => void;
  tour?: Tour;
}

export default function Panel({ stop, projects, active, onClose, tour }: Props) {
  const heading = useRef<HTMLHeadingElement>(null);
  const first = projects[0];
  const shared = projects.length > 1;

  useEffect(() => {
    heading.current?.focus();
  }, [stop.key]);

  // In a shared panel, bring the project of the current address into view.
  useEffect(() => {
    if (shared) document.getElementById(`project-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [active, shared]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <aside className="panel" aria-labelledby="panel-title">
      <div className="panel-bar">
        {tour && (
          <nav className="panel-tour" aria-label="Tour">
            <span>
              {tour.position} / {tour.total}
            </span>
            <button type="button" onClick={tour.onPrevious} disabled={!tour.onPrevious}>
              Previous
            </button>
            <button type="button" onClick={tour.onNext} disabled={!tour.onNext}>
              Next
            </button>
          </nav>
        )}
        <button type="button" className="panel-close" onClick={onClose}>
          {tour ? "Exit" : "Close"}
        </button>
      </div>

      <p className={`panel-place${stop.off ? " is-off" : ""}`}>
        {stop.category && (
          <>
            <span className="place-dot" aria-hidden="true" />
            {CATEGORY_NAME[stop.category]} ·{" "}
          </>
        )}
        {first.place}
      </p>
      <h1 id="panel-title" ref={heading} tabIndex={-1}>
        {shared ? stop.label : first.title}
      </h1>

      {projects.map((project) => (
        <section key={project.slug} id={`project-${project.slug}`} className="panel-project">
          {shared && <h2>{project.title}</h2>}
          {(project.role || project.period) && (
            <p className="panel-role">
              {project.role}
              {project.role && project.period && <span aria-hidden="true"> · </span>}
              {project.period && <span className="panel-period">{project.period}</span>}
            </p>
          )}
          {project.stack.length > 0 && <p className="panel-stack">{project.stack.join(" · ")}</p>}
          {/* Rendered from the project's Markdown file at build time. */}
          <div className="panel-body" dangerouslySetInnerHTML={{ __html: project.html }} />
          {project.images.length > 0 && (
            <div className="panel-images">
              {project.images.map((image) => (
                <img key={image.src} src={image.src} alt={image.alt} loading="lazy" />
              ))}
            </div>
          )}
          {project.links.length > 0 && (
            <p className="panel-links">
              {project.links.map((link) => (
                <a key={link.url} href={link.url} {...(link.url.startsWith("http") ? { target: "_blank", rel: "noopener" } : {})}>
                  {link.label}
                </a>
              ))}
            </p>
          )}
        </section>
      ))}
    </aside>
  );
}
