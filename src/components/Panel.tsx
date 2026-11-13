import { useEffect, useRef } from "react";
import { CATEGORY_COLOR, type Category, type Project, type Stop } from "./City";

/** A picture, or a short silent video that loops like a GIF (still, with controls, for reduced motion). */
function Media({ src, alt, poster }: { src: string; alt: string; poster?: string }) {
  if (!src.endsWith(".mp4")) return <img src={src} alt={alt} loading="lazy" />;
  const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  return (
    <video
      src={src}
      poster={poster}
      aria-label={alt}
      muted
      loop
      playsInline
      autoPlay={!still}
      controls={still}
      preload={still ? "none" : "metadata"}
    />
  );
}

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
  /** mailto: link and LinkedIn profile, offered at the end of every panel. */
  email?: string;
  linkedin?: string;
}

export default function Panel({ stop, projects, active, onClose, tour, email, linkedin }: Props) {
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

  // The page's own copy of the text (for readers without JavaScript) gives way to this panel.
  useEffect(() => {
    document.getElementById("ssr-panel")?.remove();
  }, []);

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
            <span className="place-dot" style={{ "--dot": CATEGORY_COLOR[stop.category] } as React.CSSProperties} aria-hidden="true" />
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
          {project.summary && <p className="panel-summary">{project.summary}</p>}
          {project.stack.length > 0 && (
            <ul className="panel-stack" aria-label="Tools">
              {project.stack.map((tool) => (
                <li key={tool}>{tool}</li>
              ))}
            </ul>
          )}
          {/* Rendered from the project's Markdown file at build time. */}
          <div className="panel-body" dangerouslySetInnerHTML={{ __html: project.html }} />
          {project.images.length > 0 && (
            <div className="panel-images">
              {project.images.map((image) => (
                <Media key={image.src} {...image} />
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

      {/* Getting in touch is one step from anywhere (the contact panel has its own links). */}
      {first.kind !== "contact" && (email || linkedin) && (
        <p className="panel-contact">
          {email && (
            <a className="email-button" href={email}>
              Email me
            </a>
          )}
          {linkedin && (
            <a href={linkedin} target="_blank" rel="noopener">
              LinkedIn
            </a>
          )}
        </p>
      )}
    </aside>
  );
}
