import { AzureOpenAI } from "openai";
import { logger } from "../utils/logger";

interface AiResult {
  explanation: string;
  impact: string;
  fix_code: string;
}

/**
 * Azure OpenAI–backed accessibility explanation service.
 *
 * Reads its configuration from Azure App Service environment variables:
 *   AZURE_OPENAI_ENDPOINT      e.g. https://my-resource.openai.azure.com
 *   AZURE_OPENAI_KEY           the resource key (also accepts AZURE_OPENAI_API_KEY)
 *   AZURE_OPENAI_DEPLOYMENT    the deployment name of a chat model (e.g. gpt-4o)
 *   AZURE_OPENAI_API_VERSION   the API version (defaults to 2024-10-21)
 *
 * If any of endpoint / key / deployment is missing, the service degrades
 * gracefully: it logs a warning once and returns a deterministic fallback
 * explanation so scans still complete successfully.
 */
class AiService {
  private client?: AzureOpenAI;
  private warnedMissingConfig = false;

  private deploymentName(): string {
    return (
      process.env.AZURE_OPENAI_DEPLOYMENT ||
      process.env.AZURE_OPENAI_DEPLOYMENT_NAME ||
      "gpt-4o"
    );
  }

  private apiVersion(): string {
    return process.env.AZURE_OPENAI_API_VERSION || "2024-10-21";
  }

  private azureOpenai(): AzureOpenAI | null {
    const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
    const apiKey = process.env.AZURE_OPENAI_KEY || process.env.AZURE_OPENAI_API_KEY;
    const deployment = this.deploymentName();

    if (!endpoint || !apiKey || !deployment) {
      if (!this.warnedMissingConfig) {
        this.warnedMissingConfig = true;
        logger.warn(
          "Azure OpenAI is not fully configured. Missing one or more of: " +
            "AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_KEY, AZURE_OPENAI_DEPLOYMENT. " +
            "AI explanations will use the deterministic fallback."
        );
      }
      return null;
    }

    if (!this.client) {
      this.client = new AzureOpenAI({
        endpoint,
        apiKey,
        apiVersion: this.apiVersion(),
        deployment
      });
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

    const client = this.azureOpenai();
    if (!client) {
      return this.fallbackExplain(issue);
    }

    try {
      const response = await client.chat.completions.create({
        model: this.deploymentName(),
        messages: [{ role: "user", content: prompt }],
        response_format: { type: "json_object" },
        max_tokens: 1000,
        temperature: 0.3
      });

      const text = response.choices[0]?.message?.content || "{}";
      const parsed = JSON.parse(text);
      return {
        explanation: parsed.explanation || "Unable to generate explanation.",
        impact: parsed.impact || "Unable to determine impact.",
        fix_code: parsed.fix_code || "// No fix code generated."
      };
    } catch (err) {
      logger.error("Azure OpenAI explainIssue failed:", err);
      return this.fallbackExplain(issue);
    }
  }

  async generateTestCases(issue: any): Promise<any[]> {
    const prompt = `Generate 3-5 specific accessibility test cases for this issue:
Rule: ${issue.rule_id}, WCAG: ${(issue.wcag_criteria || []).join(", ")}, Message: ${issue.message}

Respond in JSON: { "test_cases": [{ "name": "", "description": "", "steps": [], "expected_result": "" }] }`;

    const client = this.azureOpenai();
    if (!client) {
      return [];
    }

    try {
      const response = await client.chat.completions.create({
        model: this.deploymentName(),
        messages: [{ role: "user", content: prompt }],
        response_format: { type: "json_object" },
        max_tokens: 800,
        temperature: 0.3
      });
      const parsed = JSON.parse(response.choices[0]?.message?.content || "{}");
      return parsed.test_cases || [];
    } catch (err) {
      logger.warn("Azure OpenAI generateTestCases failed:", err);
      return [];
    }
  }

  private fallbackExplain(issue: any): AiResult {
    return {
      explanation: `${issue.message} — This accessibility issue affects users relying on assistive technologies.`,
      impact:
        "Users with disabilities, particularly those using screen readers or keyboard navigation, may be impacted.",
      fix_code: "// Please refer to WCAG documentation for fix guidance."
    };
  }
}

export const aiService = new AiService();
