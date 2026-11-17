// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { SUPABASE_PUBLISHABLE_KEY } from "../_shared/supabaseKeys.ts";
import {
  chooseLabel,
  existingLabelList,
  MAX_LABEL_LENGTH,
} from "../_shared/labelRules.ts";

// Load environment variables
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
// CHANGED FROM THE COURSE VERSION: this function calls Google's Gemini API
// instead of OpenAI, because OpenAI declined the student's card.
const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY");

// The Gemini model that suggests the labels.
const GEMINI_MODEL = "gemini-3.1-flash-lite";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    const { title, description } = await req.json();

    console.log("🔄 Creating task with AI suggestions...");
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      throw new Error("No authorization header");
    }

    // Initialize Supabase client
    const supabaseClient = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
      global: {
        headers: { Authorization: authHeader },
      },
    });

    // Get user session
    const {
      data: { user },
    } = await supabaseClient.auth.getUser();
    if (!user) throw new Error("No user found");

    // Create the task
    const { data, error } = await supabaseClient
      .from("tasks")
      .insert({
        title,
        description,
        completed: false,
        user_id: user.id,
      })
      .select()
      .single();

    if (error) throw error;

    // The existing labels: the default ones plus every label the user has
    // already used. Row Level Security limits this to the user's own tasks.
    const { data: labelRows, error: labelsError } = await supabaseClient
      .from("tasks")
      .select("label")
      .eq("user_id", user.id)
      .not("label", "is", null);

    // If that fails, carry on with just the default labels.
    if (labelsError) console.error("Error reading labels:", labelsError.message);
    const existingLabels = existingLabelList(
      (labelRows ?? []).map((row: { label: string | null }) => row.label)
    );

    // Get label suggestion from Gemini
    const prompt = `You choose a label for a task in a to-do list app.

Task title: "${title}"
Task description: "${description ?? ""}"

Existing labels: ${existingLabels.join(", ")}

Rules:
1. If one of the existing labels fits the task, reply with that label, spelled exactly as in the list.
2. Only if none of the existing labels fits, reply with ONE new label: lowercase, one or two words, at most ${MAX_LABEL_LENGTH} characters, using only letters, digits, spaces and hyphens.
3. A new label must not repeat or mimic an existing label: no plurals, prefixes, suffixes, rewordings or synonyms of one. For example, if "home" is an existing label, do not reply "homes", "my-home" or "home stuff": reply "home". If "priority" is an existing label, do not reply "urgent".

Reply with just the label and nothing else.`;

    const geminiResponse = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": GEMINI_API_KEY ?? "",
        },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.3,
            maxOutputTokens: 64,
          },
        }),
      }
    );
    if (!geminiResponse.ok) {
      throw new Error(`Gemini error ${geminiResponse.status}: ${await geminiResponse.text()}`);
    }
    const completion = await geminiResponse.json();

    const suggestedLabel: string | null =
      completion.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? null;

    console.log(`✨ AI Suggested Label: ${suggestedLabel}`);

    // Check the label: use the existing label if the AI repeated or rephrased
    // one, and no label (null) if the reply is not a valid label.
    const label = chooseLabel(suggestedLabel, existingLabels);
    console.log(`🏷️ Label saved: ${label}`);

    // Update the task with the suggested label
    const { data: updatedTask, error: updateError } = await supabaseClient
      .from("tasks")
      .update({ label })
      .eq("task_id", data.task_id)
      .select()
      .single();

    if (updateError) throw updateError;

    return new Response(JSON.stringify(updatedTask), {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (error) {
    // Errors from Supabase are not always Error objects, but have a message.
    const message = (error as { message?: string })?.message ?? String(error);
    console.error("Error in create-task-with-ai:", message);
    return new Response(JSON.stringify({ error: message }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
