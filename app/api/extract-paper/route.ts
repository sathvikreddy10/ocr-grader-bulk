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

    const prompt = `
You are parsing an exam question paper from the provided images.
Extract every section, every question, and every marking detail you can find.

The most important output is the "keyPoints" array for each question. These key points will be used by another AI to grade student answers, so they must be precise, complete, and their marks must add up exactly to the question's maxMarks.

Return ONLY a JSON object with this exact shape (no markdown, no commentary):
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
      return NextResponse.json(
        { error: `Mistral error: ${response.status} ${errorText}` },
        { status: 502 }
      );
    }

    const completion = await response.json();
    const responseText = completion.choices?.[0]?.message?.content ?? "";

    const usage = completion.usage;
    if (usage) {
      console.log("[extract-paper] tokens:", {
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
    console.error("Extract paper error:", error);
    const message =
      error instanceof Error ? error.message : "An unexpected error occurred.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
