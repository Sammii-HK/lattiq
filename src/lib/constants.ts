export interface Document {
  id: string;
  title: string;
  description: string;
}

export const DOCUMENTS: Document[] = [
  {
    id: "getting-started",
    title: "Getting Started",
    description: "Welcome to Lattiq — your local-first collaborative editor.",
  },
  {
    id: "meeting-notes",
    title: "Meeting Notes",
    description: "Weekly team sync and action items.",
  },
  {
    id: "project-roadmap",
    title: "Project Roadmap",
    description: "Milestones, goals, and feature planning.",
  },
  {
    id: "scratch-pad",
    title: "Scratch Pad",
    description: "Quick notes and ideas — throw anything here.",
  },
];

export function getDocumentById(id: string): Document | undefined {
  return DOCUMENTS.find((doc) => doc.id === id);
}
