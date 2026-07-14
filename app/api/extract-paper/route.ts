import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const baseUrl = process.env.MISTRAL_URL?.replace(/\/$/, "") ?? "https://api.mistral.ai/v1";
const model = process.env.MISTRAL_MODEL ?? "pixtral-12b-2409";
const apiKey = process.env.MISTRAL_API_KEY;

interface KeyPoint {
  description?: string;
  marks?: number;
}

interface Question {
  number?: string;
  section?: string;
  text?: string;
  maxMarks?: number;
  keyPoints?: KeyPoint[];
}

interface Section {
  name?: string;
  totalMarks?: number;
  instructions?: string;
}

interface Paper {
  title?: string;
  sections?: Section[];
  questions?: Question[];
}

function isValidPaper(paper: unknown): paper is Paper {
  if (typeof paper !== "object" || paper === null) return false;
  const p = paper as Paper;
  return Array.isArray(p.sections) && Array.isArray(p.questions);
}

function hasBalancedKeyPoints(paper: Paper): boolean {
  const questions = paper.questions ?? [];
  for (const q of questions) {
    const keyPoints = q.keyPoints ?? [];
    const kpSum = keyPoints.reduce((sum, kp) => sum + (Number(kp.marks) || 0), 0);
    const maxMarks = Number(q.maxMarks) || 0;
    if (maxMarks > 0 && Math.abs(kpSum - maxMarks) > 0.01) {
      return false;
    }
  }
  return true;
}

// Create a structural signature based on sections + question numbers + max marks.
// Runs with the same signature are considered to agree on the paper structure.
function paperSignature(paper: Paper): string {
  const sections = (paper.sections ?? [])
    .map((s) => String(s.name ?? "").trim())
    .filter(Boolean)
    .join("|");
  const questions = (paper.questions ?? [])
    .map((q) => `${String(q.number ?? "").trim()}:${Number(q.maxMarks) || 0}:${String(q.section ?? "").trim()}`)
    .join("|");
  return `${sections}::${questions}`;
}

function totalMaxMarks(paper: Paper): number {
  return (paper.questions ?? []).reduce((sum, q) => sum + (Number(q.maxMarks) || 0), 0);
}

function scorePaperDetails(paper: Paper): number {
  let score = 0;
  const questions = paper.questions ?? [];

  for (const q of questions) {
    const keyPoints = q.keyPoints ?? [];
    if (keyPoints.length >= 2 && keyPoints.length <= 8) {
      score += keyPoints.length * 2;
    }
    score += keyPoints.filter(
      (kp) => typeof kp.description === "string" && kp.description.length > 0
    ).length;
  }

  return score;
}

function pickBestPaper(results: Paper[]): Paper | null {
  if (results.length === 0) return null;
  if (results.length === 1) return results[0];

  // 1. Keep only results where every question's maxMarks equals sum of key points.
  const balanced = results.filter(hasBalancedKeyPoints);
  const candidates = balanced.length > 0 ? balanced : results;

  // 2. Group by structural signature and find the most common structure.
  const groups = new Map<string, Paper[]>();
  for (const paper of candidates) {
    const sig = paperSignature(paper);
    if (!groups.has(sig)) groups.set(sig, []);
    groups.get(sig)!.push(paper);
  }

  const sortedGroups = Array.from(groups.entries()).sort((a, b) => b[1].length - a[1].length);
  const largestGroup = sortedGroups[0][1];

  // 3. Among the most common structure, pick the one with the most detailed / granular key points.
  largestGroup.sort((a, b) => scorePaperDetails(b) - scorePaperDetails(a));

  return largestGroup[0];
}

async function extractOnce(
  imageParts: { type: string; image_url: { url: string } }[],
  attempt: number
): Promise<{ paper: Paper | null; tokens: { prompt: number; completion: number; total: number } }> {
  const prompt = `
You are parsing an exam question paper from the provided images.
Extract every section, every question, and every marking detail you can find.

The most important output is the "keyPoints" array for each question. These key points will be used by another AI to grade student answers, so they must be precise, complete, and their marks must add up exactly to the question's maxMarks.

Return ONLY a JSON object in this exact shape (no markdown, no commentary):
{
  "title": "string",
  "sections": [
    {
      "name": "string (e.g. Section A)",
      "totalMarks": number,
      "instructions": "string"
    }
  ],
  "questions": [
    {
      "number": "string (e.g. 1, 2(a), 3.i)",
      "section": "string (must match one of the section names)",
      "text": "string (the full question text)",
      "maxMarks": number,
      "keyPoints": [
        { "description": "string", "marks": number }
      ]
    }
  ]
}

Rules:
- Preserve the exact question numbers as they appear in the paper.
- Each question's maxMarks MUST EQUAL the sum of its keyPoint marks. Double-check this before returning.
- If the paper already lists marks per key point or per part, use those values exactly.
- If key points are not explicitly listed, infer sensible, granular key points from the question text and the max marks. Each key point should describe one specific thing the student must do or write.
- A question worth N marks should usually have between 2 and 6 key points whose marks sum to N.
- Include any section-level instructions in the section instructions field.
`.trim();

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: prompt }, ...imageParts],
        },
      ],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`[extract-paper] attempt ${attempt} failed:`, response.status, errorText);
    return { paper: null, tokens: { prompt: 0, completion: 0, total: 0 } };
  }

  const completion = await response.json();
  const responseText = completion.choices?.[0]?.message?.content ?? "";

  const usage = completion.usage;
  const tokens = {
    prompt: usage?.prompt_tokens ?? 0,
    completion: usage?.completion_tokens ?? 0,
    total: usage?.total_tokens ?? 0,
  };

  try {
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    const jsonString = jsonMatch ? jsonMatch[0] : responseText;
    const parsed = JSON.parse(jsonString);
    if (isValidPaper(parsed)) {
      return { paper: parsed, tokens };
    }
    console.error(`[extract-paper] attempt ${attempt} returned invalid paper shape`);
    return { paper: null, tokens };
  } catch (err) {
    console.error(`[extract-paper] attempt ${attempt} parse error:`, err);
    return { paper: null, tokens };
  }
}

export async function POST(request: Request) {
  if (!apiKey) {
    return NextResponse.json(
      { error: "MISTRAL_API_KEY is not configured on the server." },
      { status: 500 }
    );
  }

  try {
    const formData = await request.formData();
    const imageEntries = formData.getAll("images");

    const imageFiles = imageEntries.filter((entry): entry is File => entry instanceof File);

    if (imageFiles.length === 0) {
      return NextResponse.json(
        { error: "At least one question paper image is required." },
        { status: 400 }
      );
    }

    const imageParts = await Promise.all(
      imageFiles.map(async (file) => {
        const bytes = await file.arrayBuffer();
        const base64 = Buffer.from(bytes).toString("base64");
        return {
          type: "image_url",
          image_url: { url: `data:${file.type};base64,${base64}` },
        };
      })
    );

    // Run extraction 5 times in parallel and pick the best result.
    const RUNS = 5;
    const results = await Promise.all(
      Array.from({ length: RUNS }, (_, i) => extractOnce(imageParts, i + 1))
    );

    const validResults = results.filter(
      (r): r is { paper: Paper; tokens: { prompt: number; completion: number; total: number } } =>
        r.paper !== null
    );

    if (validResults.length === 0) {
      return NextResponse.json(
        { error: "All extraction attempts failed. Please try again." },
        { status: 502 }
      );
    }

    const papers = validResults.map((r) => r.paper);
    const best = pickBestPaper(papers);

    if (!best) {
      return NextResponse.json(
        { error: "Could not determine a reliable question paper structure." },
        { status: 502 }
      );
    }

    const totalTokens = results.reduce((sum, r) => sum + r.tokens.total, 0);
    const balancedCount = papers.filter(hasBalancedKeyPoints).length;

    console.log("[extract-paper] consensus selection:", {
      total_runs: RUNS,
      valid_runs: validResults.length,
      balanced_runs: balancedCount,
      selected_total_max_marks: totalMaxMarks(best),
      total_tokens_all_runs: totalTokens,
    });

    return NextResponse.json(best);
  } catch (error) {
    console.error("Extract paper error:", error);
    const message =
      error instanceof Error ? error.message : "An unexpected error occurred.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
