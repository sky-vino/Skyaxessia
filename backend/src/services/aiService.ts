import OpenAI from "openai";
import { logger } from "../utils/logger";

interface AiResult {
  explanation: string;
  impact: string;
  fix_code: string;
  // Tier 4 fix — distinguishes real AI-generated content from the canned
  // fallback strings so the UI can badge it clearly. Previously the fallback
  // strings were displayed as if the AI had answered, and users had no way
  // to know whether the AI call actually succeeded.
  source: "ai" | "fallback";
  // Populated only when source === "fallback"; describes why the fallback fired.
  fallback_reason?: string;
}

class AiService {
  private client?: OpenAI;

  private openai(): OpenAI | null {
    if (!process.env.OPENAI_API_KEY) {
      return null;
    }
    if (!this.client) {
      this.client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    }
    return this.client;
  }

  async explainIssue(issue: any): Promise<AiResult> {
    const prompt = `You are an expert accessibility engineer. Analyze this WCAG accessibility issue and provide:
1. A clear explanation of WHY this issue matters (2-3 sentences, plain English)
2. The USER IMPACT — who is affected and how (mention specific disability groups)
3. A concrete CODE FIX with before/after HTML/CSS/JS examples

Issue details:
- Rule: ${issue.rule_id}
- Severity: ${issue.severity}
- Message: ${issue.message}
- WCAG Criteria: ${(issue.wcag_criteria || []).join(", ")}
- Selector: ${issue.selector || "N/A"}
- HTML snippet: ${issue.html_snippet || "N/A"}
- Category: ${issue.category || "N/A"}

Respond in JSON format:
{
  "explanation": "...",
  "impact": "...",
  "fix_code": "// Before:\\n...\\n\\n// After:\\n..."
}`;

    try {
      const openai = this.openai();
      if (!openai) {
        throw new Error("OPENAI_API_KEY is not configured");
      }

      const response = await openai.chat.completions.create({
        model: process.env.OPENAI_MODEL || "gpt-4o",
        messages: [{ role: "user", content: prompt }],
        response_format: { type: "json_object" },
        max_tokens: 1000,
        temperature: 0.3
      });

      const text = response.choices[0].message.content || "{}";
      const parsed = JSON.parse(text);
      return {
        explanation: parsed.explanation || "Unable to generate explanation.",
        impact: parsed.impact || "Unable to determine impact.",
        fix_code: parsed.fix_code || "// No fix code generated.",
        source: "ai",
      };
    } catch (err) {
      logger.error("AI explain failed:", err);
      const reason = err instanceof Error ? err.message : String(err);
      return {
        explanation: `${issue.message} — This accessibility issue affects users relying on assistive technologies.`,
        impact: "Users with disabilities, particularly those using screen readers or keyboard navigation, may be impacted.",
        fix_code: "// Please refer to WCAG documentation for fix guidance.",
        source: "fallback",
        fallback_reason: reason,
      };
    }
  }

  async generateTestCases(issue: any): Promise<any[]> {
    const prompt = `Generate 3-5 specific accessibility test cases for this issue:
Rule: ${issue.rule_id}, WCAG: ${(issue.wcag_criteria || []).join(", ")}, Message: ${issue.message}

Respond in JSON: { "test_cases": [{ "name": "", "description": "", "steps": [], "expected_result": "" }] }`;

    try {
      const openai = this.openai();
      if (!openai) {
        return [];
      }

      const response = await openai.chat.completions.create({
        model: process.env.OPENAI_MODEL || "gpt-4o",
        messages: [{ role: "user", content: prompt }],
        response_format: { type: "json_object" },
        max_tokens: 800,
        temperature: 0.3
      });
      const parsed = JSON.parse(response.choices[0].message.content || "{}");
      return parsed.test_cases || [];
    } catch {
      return [];
    }
  }
}

export const aiService = new AiService();
