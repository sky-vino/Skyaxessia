"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.aiService = void 0;
const openai_1 = __importDefault(require("openai"));
const logger_1 = require("../utils/logger");
class AiService {
    openai() {
        if (!process.env.OPENAI_API_KEY) {
            return null;
        }
        if (!this.client) {
            this.client = new openai_1.default({ apiKey: process.env.OPENAI_API_KEY });
        }
        return this.client;
    }
    async explainIssue(issue) {
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
        }
        catch (err) {
            logger_1.logger.error("AI explain failed:", err);
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
    async generateTestCases(issue) {
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
        }
        catch {
            return [];
        }
    }
}
exports.aiService = new AiService();
