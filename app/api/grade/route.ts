import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const baseUrl = process.env.MISTRAL_URL?.replace(/\/$/, "") ?? "https://api.mistral.ai/v1";
const model = process.env.MISTRAL_MODEL ?? "pixtral-12b-2409";
const apiKey = process.env.MISTRAL_API_KEY;

export async function POST(request: Request) {
  if (!apiKey) {
    return NextResponse.json(
      { error: "MISTRAL_API_KEY is not configured on the server." },
      { status: 500 }
    );
  }

  try {
    const formData = await request.formData();
    const paperField = formData.get("paper");
    const imageEntries = formData.getAll("answerImages");

    if (!paperField || typeof paperField !== "string") {
      return NextResponse.json(
        { error: "Question paper JSON is required." },
        { status: 400 }
      );
    }

    const paper = JSON.parse(paperField);

    const imageFiles = imageEntries.filter(
      (entry): entry is File => entry instanceof File
    );

    if (imageFiles.length === 0) {
      return NextResponse.json(
        { error: "At least one answer script image is required." },
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

    const prompt = `
You are an experienced examiner grading a student's answer script. You must evaluate every answer STRICTLY against the key points provided in the question paper below.

QUESTION PAPER (JSON):
${JSON.stringify(paper, null, 2)}

The provided images are the pages of the student's answer script, in order.

EVALUATION RULES — FOLLOW THESE EXACTLY:
1. For every question in the question paper, read the student's answer from the images.
2. Look ONLY at the "keyPoints" array for that question. Each key point has a "description" and a "marks" value.
3. For each key point, decide whether the student's answer satisfies the intent of that description:
   - If the answer clearly satisfies the key point, award the FULL "marks" value.
   - If the answer partially satisfies it or conveys the right idea in different words, award a reasonable portion of the marks. Do not default to 0 unless the answer is completely missing or clearly wrong.
   - If the answer does NOT satisfy it at all, award 0 marks.
4. The question score is the sum of marks awarded across its key points. It MUST NOT exceed the question's "maxMarks".
5. The key points are the ONLY criteria. Do not invent new criteria or deduct marks for things not listed as key points.
6. Be generous with partial credit: similar meaning, paraphrasing, or an answer that shows understanding should count.
7. If a question is not attempted or its answer cannot be found, give it 0 and note "Not attempted / not found".
8. Before finalizing each key point award, verify: "Does the answer show the understanding or content described by this key point?" If yes (even loosely), award marks.
9. For each key point, include a confidence score from 0 to 100 (100 = completely certain).
10. For each key point, include evidence: the exact line(s) from the student's answer that justify your decision, wrapped in double quotes. If no relevant line exists, use "No matching evidence found in answer."

Return ONLY a JSON object in this exact shape (no markdown, no commentary):
{
  "totalScore": number,
  "maxTotalScore": number,
  "questions": [
    {
      "number": "string",
      "section": "string",
      "score": number,
      "maxMarks": number,
      "keyPointResults": [
        {
          "description": "string",
          "awarded": number,
          "max": number,
          "confidence": number,
          "reason": "short justification",
          "evidence": "exact quoted line(s) from the answer"
        }
      ],
      "feedback": "short overall feedback for this question"
    }
  ]
}
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
      return NextResponse.json(
        { error: `Mistral error: ${response.status} ${errorText}` },
        { status: 502 }
      );
    }

    const completion = await response.json();
    const responseText = completion.choices?.[0]?.message?.content ?? "";

    const usage = completion.usage;
    if (usage) {
      console.log("[grade] tokens:", {
        model,
        prompt_tokens: usage.prompt_tokens,
        completion_tokens: usage.completion_tokens,
        total_tokens: usage.total_tokens,
      });
    }

    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    const jsonString = jsonMatch ? jsonMatch[0] : responseText;
    const parsed = JSON.parse(jsonString);

    return NextResponse.json(parsed);
  } catch (error) {
    console.error("Grading error:", error);
    const message =
      error instanceof Error ? error.message : "An unexpected error occurred.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
