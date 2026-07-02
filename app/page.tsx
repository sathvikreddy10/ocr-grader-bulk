"use client";

import { useState, useCallback, useEffect } from "react";

interface KeyPoint {
  description: string;
  marks: number;
}

interface Question {
  number: string;
  section: string;
  text: string;
  maxMarks: number;
  keyPoints: KeyPoint[];
}

interface Section {
  name: string;
  totalMarks?: number;
  instructions?: string;
}

interface Paper {
  title?: string;
  sections: Section[];
  questions: Question[];
}

interface SavedPaper {
  id: string;
  name: string;
  createdAt: number;
  paper: Paper;
}

interface KeyPointResult {
  description: string;
  awarded: number;
  max: number;
  reason: string;
  confidence: number;
  evidence?: string;
}

interface GradedQuestion {
  number: string;
  section: string;
  score: number;
  maxMarks: number;
  keyPointResults: KeyPointResult[];
  feedback: string;
}

interface GradeResult {
  totalScore: number;
  maxTotalScore: number;
  questions: GradedQuestion[];
}

type StudentStatus = "pending" | "grading" | "done" | "error";

interface StudentRecord {
  id: string;
  name: string;
  answerFile: File;
  answerImages: File[];
  status: StudentStatus;
  result?: GradeResult;
  error?: string;
}

type Step =
  | "home"
  | "extract"
  | "review"
  | "bulk"
  | "results";

const SAVED_PAPERS_KEY = "ocr-grader-saved-papers";

function clsx(...classes: (string | false | undefined)[]) {
  return classes.filter(Boolean).join(" ");
}

function generateId() {
  return Math.random().toString(36).slice(2, 10);
}

function readSavedPapers(): SavedPaper[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(SAVED_PAPERS_KEY);
    return raw ? (JSON.parse(raw) as SavedPaper[]) : [];
  } catch {
    return [];
  }
}

function writeSavedPapers(papers: SavedPaper[]) {
  if (typeof window === "undefined") return;
  localStorage.setItem(SAVED_PAPERS_KEY, JSON.stringify(papers));
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
        {label}
      </label>
      {children}
    </div>
  );
}

function DropZone({
  id,
  label,
  file,
  onDrop,
  accept = "application/pdf",
}: {
  id: string;
  label: string;
  file: File | null;
  onDrop: (files: FileList | null) => void;
  accept?: string;
}) {
  return (
    <div className="mt-2">
      <label
        htmlFor={id}
        className="flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed border-zinc-300 bg-zinc-50 px-6 py-10 hover:border-zinc-400 hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:hover:border-zinc-600 dark:hover:bg-zinc-800"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          onDrop(e.dataTransfer.files);
        }}
      >
        <svg
          className="mb-3 h-10 w-10 text-zinc-400"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          aria-hidden="true"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.5}
            d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a4.5 4.5 0 00-4.5-4.5H10.5z"
          />
        </svg>
        <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
          {file ? file.name : label}
        </span>
        <span className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
          PDF only
        </span>
        <input
          id={id}
          type="file"
          accept={accept}
          className="sr-only"
          onChange={(e) => onDrop(e.target.files)}
        />
      </label>
    </div>
  );
}

async function convertPdfToImages(file: File, prefix: string): Promise<File[]> {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";

  const buffer = await file.arrayBuffer();
  const pdf = await pdfjs.getDocument({ data: buffer }).promise;
  const images: File[] = [];

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const scale = 1.5;
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) continue;

    canvas.width = viewport.width;
    canvas.height = viewport.height;
    await page.render({ canvasContext: ctx, viewport, canvas }).promise;

    const blob = await new Promise<Blob>((resolve) => {
      canvas.toBlob((b) => resolve(b!), "image/png", 1);
    });
    images.push(new File([blob], `${prefix}-${i}.png`, { type: "image/png" }));
  }

  return images;
}

export default function Home() {
  const [step, setStep] = useState<Step>("home");

  const [savedPapers, setSavedPapers] = useState<SavedPaper[]>([]);
  const [selectedPaperId, setSelectedPaperId] = useState<string | null>(null);

  const [paperFile, setPaperFile] = useState<File | null>(null);
  const [paperImages, setPaperImages] = useState<File[] | null>(null);
  const [paper, setPaper] = useState<Paper | null>(null);
  const [paperName, setPaperName] = useState("");

  const [students, setStudents] = useState<StudentRecord[]>([]);
  const [studentName, setStudentName] = useState("");
  const [answerFile, setAnswerFile] = useState<File | null>(null);
  const [answerImages, setAnswerImages] = useState<File[] | null>(null);

  const [loading, setLoading] = useState(false);
  const [loadingMessage, setLoadingMessage] = useState("");
  const [error, setError] = useState<string | null>(null);

  const [expandedStudent, setExpandedStudent] = useState<string | null>(null);

  useEffect(() => {
    setSavedPapers(readSavedPapers());
  }, []);

  useEffect(() => {
    writeSavedPapers(savedPapers);
  }, [savedPapers]);

  const selectedPaper = savedPapers.find((p) => p.id === selectedPaperId) ?? null;

  const resetAll = () => {
    setStep("home");
    setPaperFile(null);
    setPaperImages(null);
    setPaper(null);
    setPaperName("");
    setStudents([]);
    setStudentName("");
    setAnswerFile(null);
    setAnswerImages(null);
    setError(null);
    setExpandedStudent(null);
  };

  const resetNewPaper = () => {
    setPaperFile(null);
    setPaperImages(null);
    setPaper(null);
    setPaperName("");
  };

  const onPaperDrop = useCallback(
    async (files: FileList | null) => {
      setError(null);
      setPaperImages(null);
      const selected = files?.[0];
      if (!selected) return;
      if (selected.type !== "application/pdf") {
        setError("Please upload a PDF question paper.");
        setPaperFile(null);
        return;
      }
      setPaperFile(selected);
      setLoading(true);
      setLoadingMessage("Converting question paper pages to images...");
      try {
        const images = await convertPdfToImages(selected, "paper-page");
        setPaperImages(images);
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Failed to convert question paper to images."
        );
        setPaperFile(null);
      } finally {
        setLoading(false);
        setLoadingMessage("");
      }
    },
    []
  );

  const extractPaper = async () => {
    if (!paperImages || paperImages.length === 0) {
      setError("Please upload and convert the question paper PDF first.");
      return;
    }
    setLoading(true);
    setLoadingMessage("Reading the question paper with Mistral...");
    setError(null);

    const formData = new FormData();
    paperImages.forEach((image) => formData.append("images", image));

    try {
      const response = await fetch("/api/extract-paper", {
        method: "POST",
        body: formData,
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || "Failed to extract question paper.");
      }
      setPaper(data);
      setPaperName(data.title || paperFile?.name.replace(/\.pdf$/i, "") || "Untitled Paper");
      setStep("review");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setLoading(false);
      setLoadingMessage("");
    }
  };

  const savePaper = () => {
    if (!paper) return;
    const name = paperName.trim() || "Untitled Paper";
    const newPaper: SavedPaper = {
      id: generateId(),
      name,
      createdAt: Date.now(),
      paper,
    };
    setSavedPapers((prev) => [newPaper, ...prev]);
    setSelectedPaperId(newPaper.id);
    resetNewPaper();
    setStep("bulk");
  };

  const deletePaper = (id: string) => {
    setSavedPapers((prev) => prev.filter((p) => p.id !== id));
    if (selectedPaperId === id) setSelectedPaperId(null);
  };

  const updateSection = (index: number, field: keyof Section, value: string | number) => {
    if (!paper) return;
    const sections = [...paper.sections];
    sections[index] = { ...sections[index], [field]: value };
    setPaper({ ...paper, sections });
  };

  const updateQuestion = (index: number, field: keyof Question, value: string | number) => {
    if (!paper) return;
    const questions = [...paper.questions];
    questions[index] = { ...questions[index], [field]: value };
    setPaper({ ...paper, questions });
  };

  const updateKeyPoint = (
    qIndex: number,
    kpIndex: number,
    field: keyof KeyPoint,
    value: string | number
  ) => {
    if (!paper) return;
    const questions = [...paper.questions];
    const keyPoints = [...questions[qIndex].keyPoints];
    keyPoints[kpIndex] = { ...keyPoints[kpIndex], [field]: value };
    questions[qIndex] = { ...questions[qIndex], keyPoints };
    setPaper({ ...paper, questions });
  };

  const addKeyPoint = (qIndex: number) => {
    if (!paper) return;
    const questions = [...paper.questions];
    questions[qIndex].keyPoints.push({ description: "", marks: 1 });
    setPaper({ ...paper, questions });
  };

  const removeKeyPoint = (qIndex: number, kpIndex: number) => {
    if (!paper) return;
    const questions = [...paper.questions];
    questions[qIndex].keyPoints.splice(kpIndex, 1);
    setPaper({ ...paper, questions });
  };

  const addQuestion = () => {
    if (!paper) return;
    const sectionName = paper.sections[0]?.name ?? "";
    setPaper({
      ...paper,
      questions: [
        ...paper.questions,
        {
          number: "",
          section: sectionName,
          text: "",
          maxMarks: 0,
          keyPoints: [{ description: "", marks: 0 }],
        },
      ],
    });
  };

  const removeQuestion = (index: number) => {
    if (!paper) return;
    const questions = [...paper.questions];
    questions.splice(index, 1);
    setPaper({ ...paper, questions });
  };

  const onAnswerDrop = useCallback(
    async (files: FileList | null) => {
      setError(null);
      setAnswerImages(null);
      const selected = files?.[0];
      if (!selected) return;
      if (selected.type !== "application/pdf") {
        setError("Please upload a PDF answer script.");
        return;
      }
      setAnswerFile(selected);
      setLoading(true);
      setLoadingMessage("Converting answer PDF pages to images...");
      try {
        const images = await convertPdfToImages(selected, "answer-page");
        setAnswerImages(images);
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Failed to convert answer PDF to images."
        );
        setAnswerFile(null);
      } finally {
        setLoading(false);
        setLoadingMessage("");
      }
    },
    []
  );

  const addStudent = () => {
    if (!studentName.trim()) {
      setError("Please enter a student name.");
      return;
    }
    if (!answerImages || answerImages.length === 0) {
      setError("Please upload and convert an answer PDF first.");
      return;
    }
    if (!answerFile) return;

    const record: StudentRecord = {
      id: generateId(),
      name: studentName.trim(),
      answerFile,
      answerImages,
      status: "pending",
    };
    setStudents((prev) => [...prev, record]);
    setStudentName("");
    setAnswerFile(null);
    setAnswerImages(null);
    setError(null);
  };

  const removeStudent = (id: string) => {
    setStudents((prev) => prev.filter((s) => s.id !== id));
  };

  const gradeStudent = async (student: StudentRecord) => {
    if (!selectedPaper) return;

    setStudents((prev) =>
      prev.map((s) => (s.id === student.id ? { ...s, status: "grading" } : s))
    );

    const formData = new FormData();
    formData.append("paper", JSON.stringify(selectedPaper.paper));
    student.answerImages.forEach((image) => formData.append("answerImages", image));

    try {
      const response = await fetch("/api/grade", {
        method: "POST",
        body: formData,
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || "Failed to grade the answer script.");
      }
      setStudents((prev) =>
        prev.map((s) =>
          s.id === student.id ? { ...s, status: "done", result: data as GradeResult } : s
        )
      );
    } catch (err) {
      setStudents((prev) =>
        prev.map((s) =>
          s.id === student.id
            ? {
                ...s,
                status: "error",
                error: err instanceof Error ? err.message : "Grading failed",
              }
            : s
        )
      );
    }
  };

  const gradeAll = async () => {
    const pending = students.filter((s) => s.status === "pending" || s.status === "error");
    for (const student of pending) {
      await gradeStudent(student);
    }
  };

  const groupedQuestions = (student: StudentRecord) => {
    if (!student.result) return [];
    const map = new Map<string, GradedQuestion[]>();
    for (const q of student.result.questions) {
      if (!map.has(q.section)) map.set(q.section, []);
      map.get(q.section)!.push(q);
    }
    return Array.from(map.entries()).map(([section, questions]) => ({
      section,
      questions,
    }));
  };

  const doneCount = students.filter((s) => s.status === "done").length;
  const totalScoreSum = students.reduce((sum, s) => sum + (s.result?.totalScore ?? 0), 0);
  const totalMaxSum = students.reduce((sum, s) => sum + (s.result?.maxTotalScore ?? 0), 0);

  return (
    <main className="min-h-screen bg-zinc-50 px-4 py-12 dark:bg-zinc-950">
      <div className="mx-auto max-w-6xl space-y-8">
        <div className="text-center">
          <h1 className="text-3xl font-bold tracking-tight text-zinc-900 dark:text-zinc-50 sm:text-4xl">
            Bulk Answer Script Grader
          </h1>
          <p className="mt-3 text-lg text-zinc-600 dark:text-zinc-400">
            Save question papers, bulk upload student answer scripts, and view
            question-wise results.
          </p>
        </div>

        {error && (
          <div className="rounded-xl bg-red-50 p-4 text-sm text-red-700 dark:bg-red-950 dark:text-red-200">
            {error}
          </div>
        )}

        {loading && (
          <div className="flex items-center justify-center rounded-2xl border border-zinc-200 bg-white p-8 dark:border-zinc-800 dark:bg-zinc-900">
            <svg className="mr-3 h-6 w-6 animate-spin text-indigo-600" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path
                className="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
              />
            </svg>
            <span className="font-medium text-zinc-700 dark:text-zinc-300">{loadingMessage}</span>
          </div>
        )}

        {/* Home: saved papers */}
        {step === "home" && !loading && (
          <div className="space-y-6">
            <div className="flex items-center justify-between">
              <h2 className="text-xl font-bold text-zinc-900 dark:text-zinc-50">
                Saved Question Papers
              </h2>
              <button
                onClick={() => {
                  resetNewPaper();
                  setStep("extract");
                }}
                className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500"
              >
                + Create New Paper
              </button>
            </div>

            {savedPapers.length === 0 ? (
              <div className="rounded-2xl border border-zinc-200 bg-white p-8 text-center dark:border-zinc-800 dark:bg-zinc-900">
                <p className="text-zinc-600 dark:text-zinc-400">
                  No saved question papers yet. Upload one to get started.
                </p>
              </div>
            ) : (
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {savedPapers.map((p) => (
                  <div
                    key={p.id}
                    className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900"
                  >
                    <h3 className="font-semibold text-zinc-900 dark:text-zinc-50">{p.name}</h3>
                    <p className="text-sm text-zinc-500 dark:text-zinc-400">
                      {p.paper.questions.length} question{p.paper.questions.length === 1 ? "" : "s"}
                    </p>
                    <div className="mt-4 flex gap-2">
                      <button
                        onClick={() => {
                          setSelectedPaperId(p.id);
                          setStep("bulk");
                        }}
                        className="flex-1 rounded-lg bg-indigo-600 px-3 py-2 text-sm font-semibold text-white hover:bg-indigo-500"
                      >
                        Grade Students
                      </button>
                      <button
                        onClick={() => deletePaper(p.id)}
                        className="rounded-lg bg-red-50 px-3 py-2 text-sm font-semibold text-red-600 hover:bg-red-100 dark:bg-red-950 dark:hover:bg-red-900"
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Extract new paper */}
        {step === "extract" && !loading && (
          <div className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900 sm:p-8">
            <div className="flex items-center justify-between">
              <h2 className="text-xl font-bold text-zinc-900 dark:text-zinc-50">
                Step 1: Upload Question Paper
              </h2>
              <button
                onClick={() => setStep("home")}
                className="text-sm font-medium text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-200"
              >
                ← Back
              </button>
            </div>
            <p className="mt-2 text-zinc-600 dark:text-zinc-400">
              We&apos;ll convert each page to an image and extract sections, question numbers, max marks, and key points.
            </p>
            <DropZone
              id="paper-file"
              label="Click or drag the question paper PDF here"
              file={paperFile}
              onDrop={onPaperDrop}
            />
            {paperImages && (
              <p className="mt-3 text-sm text-zinc-600 dark:text-zinc-400">
                Converted {paperImages.length} page{paperImages.length === 1 ? "" : "s"} to images.
              </p>
            )}
            <button
              onClick={extractPaper}
              disabled={!paperImages || paperImages.length === 0}
              className="mt-6 inline-flex w-full items-center justify-center rounded-xl bg-indigo-600 px-5 py-3 text-base font-semibold text-white shadow-sm transition-colors hover:bg-indigo-500 disabled:cursor-not-allowed disabled:bg-zinc-400"
            >
              Extract Question Paper
            </button>
          </div>
        )}

        {/* Review and save paper */}
        {step === "review" && paper && !loading && (
          <div className="space-y-6">
            <div className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900 sm:p-8">
              <div className="flex items-center justify-between">
                <h2 className="text-xl font-bold text-zinc-900 dark:text-zinc-50">
                  Step 2: Review &amp; Save Paper
                </h2>
                <button
                  onClick={() => setStep("home")}
                  className="text-sm font-medium text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-200"
                >
                  Cancel
                </button>
              </div>
              <p className="mt-2 text-zinc-600 dark:text-zinc-400">
                Fix any mistakes. Each question&aposs max marks must equal the sum of its key-point marks.
              </p>

              <div className="mt-6">
                <Field label="Paper name">
                  <input
                    value={paperName}
                    onChange={(e) => setPaperName(e.target.value)}
                    placeholder="e.g. Mid-term Exam 2025"
                    className="w-full rounded-lg border border-zinc-300 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900"
                  />
                </Field>
              </div>

              <div className="mt-6 space-y-4">
                <h3 className="font-semibold text-zinc-900 dark:text-zinc-50">Sections</h3>
                {paper.sections.map((section, sIdx) => (
                  <div
                    key={sIdx}
                    className="grid gap-3 rounded-xl border border-zinc-100 bg-zinc-50 p-4 dark:border-zinc-800 dark:bg-zinc-950 sm:grid-cols-3"
                  >
                    <Field label="Section name">
                      <input
                        value={section.name}
                        onChange={(e) => updateSection(sIdx, "name", e.target.value)}
                        placeholder="Section A"
                        className="w-full rounded-lg border border-zinc-300 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900"
                      />
                    </Field>
                    <Field label="Total marks">
                      <input
                        type="number"
                        value={section.totalMarks ?? ""}
                        onChange={(e) => updateSection(sIdx, "totalMarks", Number(e.target.value))}
                        placeholder="20"
                        className="w-full rounded-lg border border-zinc-300 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900"
                      />
                    </Field>
                    <Field label="Instructions">
                      <input
                        value={section.instructions ?? ""}
                        onChange={(e) => updateSection(sIdx, "instructions", e.target.value)}
                        placeholder="Answer all questions"
                        className="w-full rounded-lg border border-zinc-300 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900"
                      />
                    </Field>
                  </div>
                ))}
              </div>

              <div className="mt-8 space-y-6">
                <div className="flex items-center justify-between">
                  <h3 className="font-semibold text-zinc-900 dark:text-zinc-50">Questions</h3>
                  <button
                    onClick={addQuestion}
                    className="rounded-lg border border-indigo-600 px-3 py-1.5 text-sm font-semibold text-indigo-600 hover:bg-indigo-50 dark:hover:bg-indigo-950"
                  >
                    + Add Question
                  </button>
                </div>
                {paper.questions.map((q, qIdx) => (
                  <div
                    key={qIdx}
                    className="rounded-xl border border-zinc-200 p-4 dark:border-zinc-800"
                  >
                    <div className="grid gap-3 sm:grid-cols-12">
                      <div className="sm:col-span-2">
                        <Field label="Question #">
                          <input
                            value={q.number}
                            onChange={(e) => updateQuestion(qIdx, "number", e.target.value)}
                            placeholder="1"
                            className="w-full rounded-lg border border-zinc-300 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900"
                          />
                        </Field>
                      </div>
                      <div className="sm:col-span-3">
                        <Field label="Section">
                          <select
                            value={q.section}
                            onChange={(e) => updateQuestion(qIdx, "section", e.target.value)}
                            className="w-full rounded-lg border border-zinc-300 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900"
                          >
                            {paper.sections.map((s) => (
                              <option key={s.name} value={s.name}>
                                {s.name}
                              </option>
                            ))}
                          </select>
                        </Field>
                      </div>
                      <div className="sm:col-span-2">
                        <Field label="Max marks">
                          <input
                            type="number"
                            value={q.maxMarks}
                            onChange={(e) =>
                              updateQuestion(qIdx, "maxMarks", Number(e.target.value))
                            }
                            placeholder="5"
                            className="w-full rounded-lg border border-zinc-300 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900"
                          />
                        </Field>
                      </div>
                      <div className="sm:col-span-4">
                        <Field label="Question text">
                          <input
                            value={q.text}
                            onChange={(e) => updateQuestion(qIdx, "text", e.target.value)}
                            placeholder="Explain..."
                            className="w-full rounded-lg border border-zinc-300 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900"
                          />
                        </Field>
                      </div>
                      <div className="sm:col-span-1 flex items-end">
                        <button
                          onClick={() => removeQuestion(qIdx)}
                          className="w-full rounded-lg bg-red-50 px-3 py-2 text-red-600 hover:bg-red-100 dark:bg-red-950 dark:hover:bg-red-900"
                        >
                          ×
                        </button>
                      </div>
                    </div>

                    <div className="mt-4">
                      <div className="mb-2 text-sm font-medium text-zinc-700 dark:text-zinc-300">
                        Key Points
                      </div>
                      <div className="space-y-2">
                        {q.keyPoints.map((kp, kpIdx) => (
                          <div key={kpIdx} className="flex gap-2">
                            <div className="flex-1">
                              <Field label="Key point description">
                                <input
                                  value={kp.description}
                                  onChange={(e) =>
                                    updateKeyPoint(qIdx, kpIdx, "description", e.target.value)
                                  }
                                  placeholder="Defines the term correctly"
                                  className="w-full rounded-lg border border-zinc-300 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900"
                                />
                              </Field>
                            </div>
                            <div className="w-24">
                              <Field label="Marks">
                                <input
                                  type="number"
                                  value={kp.marks}
                                  onChange={(e) =>
                                    updateKeyPoint(qIdx, kpIdx, "marks", Number(e.target.value))
                                  }
                                  placeholder="2"
                                  className="w-full rounded-lg border border-zinc-300 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900"
                                />
                              </Field>
                            </div>
                            <div className="flex items-end">
                              <button
                                onClick={() => removeKeyPoint(qIdx, kpIdx)}
                                className="rounded-lg bg-red-50 px-3 py-2 text-red-600 hover:bg-red-100 dark:bg-red-950 dark:hover:bg-red-900"
                              >
                                ×
                              </button>
                            </div>
                          </div>
                        ))}
                        <button
                          onClick={() => addKeyPoint(qIdx)}
                          className="text-sm font-medium text-indigo-600 hover:text-indigo-500"
                        >
                          + Add key point
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              <button
                onClick={savePaper}
                className="mt-6 inline-flex w-full items-center justify-center rounded-xl bg-indigo-600 px-5 py-3 text-base font-semibold text-white shadow-sm transition-colors hover:bg-indigo-500"
              >
                Save Paper &amp; Go to Bulk Grading
              </button>
            </div>
          </div>
        )}

        {/* Bulk grading */}
        {step === "bulk" && selectedPaper && !loading && (
          <div className="space-y-6">
            <div className="flex items-center justify-between rounded-2xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
              <div>
                <h2 className="text-xl font-bold text-zinc-900 dark:text-zinc-50">
                  Bulk Grading: {selectedPaper.name}
                </h2>
                <p className="text-zinc-600 dark:text-zinc-400">
                  {selectedPaper.paper.questions.length} question
                  {selectedPaper.paper.questions.length === 1 ? "" : "s"} | {doneCount} of{" "}
                  {students.length} graded
                </p>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => setStep("home")}
                  className="rounded-lg border border-zinc-300 px-4 py-2 text-sm font-semibold text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                >
                  Back
                </button>
                {students.some((s) => s.status === "done") && (
                  <button
                    onClick={() => setStep("results")}
                    className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500"
                  >
                    View Results
                  </button>
                )}
              </div>
            </div>

            <div className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900 sm:p-8">
              <h3 className="font-semibold text-zinc-900 dark:text-zinc-50">Add Student</h3>
              <div className="mt-3 grid gap-4 sm:grid-cols-2">
                <Field label="Student name">
                  <input
                    value={studentName}
                    onChange={(e) => setStudentName(e.target.value)}
                    placeholder="e.g. Rahul Sharma"
                    className="w-full rounded-lg border border-zinc-300 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900"
                  />
                </Field>
                <Field label="Answer script PDF">
                  <DropZone
                    id="answer-file"
                    label={answerFile ? answerFile.name : "Click or drag answer PDF"}
                    file={answerFile}
                    onDrop={onAnswerDrop}
                  />
                </Field>
              </div>
              {answerImages && (
                <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
                  Converted {answerImages.length} page{answerImages.length === 1 ? "" : "s"}.
                </p>
              )}
              <button
                onClick={addStudent}
                className="mt-4 inline-flex items-center justify-center rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500"
              >
                Add to Queue
              </button>
            </div>

            {students.length > 0 && (
              <div className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900 sm:p-8">
                <div className="flex items-center justify-between">
                  <h3 className="font-semibold text-zinc-900 dark:text-zinc-50">Student Queue</h3>
                  <button
                    onClick={gradeAll}
                    disabled={students.every((s) => s.status === "done")}
                    className="rounded-lg border border-indigo-600 px-3 py-1.5 text-sm font-semibold text-indigo-600 hover:bg-indigo-50 disabled:opacity-50 dark:hover:bg-indigo-950"
                  >
                    Grade All Pending
                  </button>
                </div>

                <div className="mt-4 space-y-2">
                  {students.map((student) => (
                    <div
                      key={student.id}
                      className="flex items-center justify-between rounded-xl border border-zinc-100 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-950"
                    >
                      <div>
                        <span className="font-medium text-zinc-900 dark:text-zinc-100">
                          {student.name}
                        </span>
                        <span className="ml-2 text-xs text-zinc-500 dark:text-zinc-400">
                          {student.answerFile.name}
                        </span>
                        {student.result && (
                          <span className="ml-2 text-sm font-semibold text-indigo-700 dark:text-indigo-300">
                            {student.result.totalScore} / {student.result.maxTotalScore}
                          </span>
                        )}
                        {student.error && (
                          <span className="ml-2 text-sm text-red-600 dark:text-red-400">
                            {student.error}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        {student.status === "grading" ? (
                          <svg
                            className="h-5 w-5 animate-spin text-indigo-600"
                            viewBox="0 0 24 24"
                            fill="none"
                          >
                            <circle
                              className="opacity-25"
                              cx="12"
                              cy="12"
                              r="10"
                              stroke="currentColor"
                              strokeWidth="4"
                            />
                            <path
                              className="opacity-75"
                              fill="currentColor"
                              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                            />
                          </svg>
                        ) : (
                          <span
                            className={clsx(
                              "rounded px-2 py-0.5 text-xs font-semibold",
                              student.status === "done"
                                ? "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300"
                                : student.status === "error"
                                ? "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300"
                                : "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400"
                            )}
                          >
                            {student.status}
                          </span>
                        )}
                        <button
                          onClick={() => gradeStudent(student)}
                          disabled={student.status === "grading"}
                          className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
                        >
                          {student.status === "done" ? "Re-grade" : "Grade"}
                        </button>
                        <button
                          onClick={() => removeStudent(student.id)}
                          className="rounded-lg bg-red-50 px-3 py-1.5 text-xs font-semibold text-red-600 hover:bg-red-100 dark:bg-red-950 dark:hover:bg-red-900"
                        >
                          ×
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Results table */}
        {step === "results" && selectedPaper && !loading && (
          <div className="space-y-6">
            <div className="flex items-center justify-between rounded-2xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
              <div>
                <h2 className="text-2xl font-bold text-zinc-900 dark:text-zinc-50">
                  Results: {selectedPaper.name}
                </h2>
                <p className="text-zinc-600 dark:text-zinc-400">
                  Class average: {totalMaxSum > 0 ? ((totalScoreSum / totalMaxSum) * 100).toFixed(1) : 0}% |{" "}
                  {doneCount}/{students.length} graded
                </p>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => setStep("bulk")}
                  className="rounded-lg border border-zinc-300 px-4 py-2 text-sm font-semibold text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                >
                  Back to Queue
                </button>
                <button
                  onClick={resetAll}
                  className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500"
                >
                  New Session
                </button>
              </div>
            </div>

            <div className="overflow-hidden rounded-2xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
              <table className="min-w-full divide-y divide-zinc-200 dark:divide-zinc-800">
                <thead className="bg-zinc-50 dark:bg-zinc-950">
                  <tr>
                    <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                      Student
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                      Score
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                      Percentage
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                      Status
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
                  {students.map((student) => {
                    const percentage =
                      student.result && student.result.maxTotalScore > 0
                        ? (student.result.totalScore / student.result.maxTotalScore) * 100
                        : 0;
                    return (
                      <tr key={student.id}>
                        <td className="px-6 py-4 font-medium text-zinc-900 dark:text-zinc-100">
                          {student.name}
                        </td>
                        <td className="px-6 py-4 text-zinc-700 dark:text-zinc-300">
                          {student.result ? (
                            <>
                              {student.result.totalScore} / {student.result.maxTotalScore}
                            </>
                          ) : (
                            "—"
                          )}
                        </td>
                        <td className="px-6 py-4 text-zinc-700 dark:text-zinc-300">
                          {student.result ? `${percentage.toFixed(1)}%` : "—"}
                        </td>
                        <td className="px-6 py-4">
                          <span
                            className={clsx(
                              "rounded px-2 py-0.5 text-xs font-semibold",
                              student.status === "done"
                                ? "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300"
                                : student.status === "error"
                                ? "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300"
                                : "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400"
                            )}
                          >
                            {student.status}
                          </span>
                        </td>
                        <td className="px-6 py-4">
                          <button
                            onClick={() =>
                              setExpandedStudent(
                                expandedStudent === student.id ? null : student.id
                              )
                            }
                            disabled={student.status !== "done"}
                            className="text-sm font-semibold text-indigo-600 hover:text-indigo-500 disabled:text-zinc-400"
                          >
                            {expandedStudent === student.id ? "Hide" : "Breakdown"}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {expandedStudent && (
              <div className="rounded-2xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
                {(() => {
                  const student = students.find((s) => s.id === expandedStudent);
                  if (!student || !student.result) return null;
                  return (
                    <div className="space-y-6">
                      <div className="flex items-center justify-between">
                        <h3 className="text-xl font-bold text-zinc-900 dark:text-zinc-50">
                          {student.name} — Breakdown
                        </h3>
                        <span className="rounded-lg bg-indigo-100 px-3 py-1 text-sm font-bold text-indigo-700 dark:bg-indigo-900 dark:text-indigo-300">
                          {student.result.totalScore} / {student.result.maxTotalScore}
                        </span>
                      </div>
                      {groupedQuestions(student).map(({ section, questions }) => (
                        <div key={section}>
                          <h4 className="mb-3 font-semibold text-zinc-900 dark:text-zinc-50">
                            {section}
                          </h4>
                          <div className="space-y-3">
                            {questions.map((q) => (
                              <div
                                key={q.number}
                                className="rounded-xl border border-zinc-100 bg-zinc-50 p-4 dark:border-zinc-800 dark:bg-zinc-950"
                              >
                                <div className="flex items-start justify-between gap-4">
                                  <div>
                                    <span className="font-semibold text-zinc-900 dark:text-zinc-100">
                                      Question {q.number}
                                    </span>
                                    <p className="text-sm text-zinc-600 dark:text-zinc-400">
                                      {q.feedback}
                                    </p>
                                  </div>
                                  <span className="shrink-0 rounded-lg bg-indigo-100 px-3 py-1 text-sm font-bold text-indigo-700 dark:bg-indigo-900 dark:text-indigo-300">
                                    {q.score} / {q.maxMarks}
                                  </span>
                                </div>
                                <ul className="mt-3 space-y-3">
                                  {q.keyPointResults.map((kp, idx) => (
                                    <li
                                      key={idx}
                                      className="rounded-lg border border-zinc-200 bg-white p-3 text-sm dark:border-zinc-800 dark:bg-zinc-900"
                                    >
                                      <div className="flex items-start justify-between gap-3">
                                        <span className="font-medium text-zinc-800 dark:text-zinc-200">
                                          {kp.description}
                                        </span>
                                        <div className="flex shrink-0 items-center gap-2">
                                          <span
                                            className={clsx(
                                              "rounded px-2 py-0.5 text-xs font-semibold",
                                              (kp.confidence ?? 0) >= 80
                                                ? "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300"
                                                : (kp.confidence ?? 0) >= 50
                                                ? "bg-yellow-100 text-yellow-700 dark:bg-yellow-900 dark:text-yellow-300"
                                                : "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300"
                                            )}
                                          >
                                            {Math.round(kp.confidence ?? 0)}% conf
                                          </span>
                                          <span className="rounded bg-indigo-100 px-2 py-0.5 text-xs font-bold text-indigo-700 dark:bg-indigo-900 dark:text-indigo-300">
                                            {kp.awarded}/{kp.max}
                                          </span>
                                        </div>
                                      </div>
                                      <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                                        {kp.reason}
                                      </p>
                                      {kp.evidence && (
                                        <p className="mt-2 text-xs text-zinc-600 dark:text-zinc-400">
                                          Evidence:{" "}
                                          <span className="italic text-zinc-800 dark:text-zinc-300">
                                            &quot;{kp.evidence}&quot;
                                          </span>
                                        </p>
                                      )}
                                    </li>
                                  ))}
                                </ul>
                              </div>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  );
                })()}
              </div>
            )}
          </div>
        )}
      </div>
    </main>
  );
}
