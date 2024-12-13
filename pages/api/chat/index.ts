import { openai } from '@ai-sdk/openai';
import { streamText } from 'ai';
import { tools } from '../../../ai/tools';
import { NextRequest } from 'next/server';

export const config = {
  runtime: 'edge'
};

// Allow streaming responses up to 30 seconds
export const maxDuration = 40;

export default async function handler(req: NextRequest) {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  try {
    const { messages, currentDetails } = await req.json();

    // Validate request
    if (!messages?.length || !currentDetails) {
      return new Response(
        JSON.stringify({ 
          error: 'Invalid request: messages and currentDetails are required' 
        }),
        { status: 400 }
      );
    }

    const staticSystemPrompt = `You are a travel assistant.
      IMPORTANT: Always respond in English regardless of the PDF export language setting.

      IMPORTANT INSTRUCTIONS:

      1. When users ask to change settings,
        - FIRST provide a brief acknowledgment message
        - THEN use the appropriate tool:
          - For budget changes: "Sure, I'll help you adjust your budget." with the budgetSelector
          - For date changes: "Let's update your travel dates." with the datePicker
          - For preference changes: "Sure, I'll help you set your preferences." with the preferenceSelector
          - For language changes: "No problem, I'll help you change the language." with the languageSelector
          - For transport options: "Let's look at transport options." with the transportSelector
      2. When users ask for information about places, 
        - FIRST respond with an acknowledgment
        - THEN proceed to triggering the tool:
          - For showing ONE place: reply with acknowledgement, along with the tool placeCard (e.g., "show me one theatre", "show me one restaurant", "show me The Little Mermaid statue")
          - For showing MULTIPLE places, reply with acknowledgement, along with the tool placeCarousel and use carousel with searchText (e.g., "show me cafes", "show me museums near me", "find restaurants in the city")
          - For showing places based on preferences, reply with acknowledgement, along with the tool placeCarousel and use carousel with preferences parameter
      3. When users update any travel parameters (budget, dates, preferences, language):
          - Immediately respond to acknowledge the change in 1-2 short sentences
          - Briefly mention how this affects their travel plans (e.g., "Great! I'll focus on budget-friendly activities within your new $X budget.")
      4. When users ask about weather:
          - Explain that we can show historical weather data from the previous year for the same month
          - Use the weatherChart tool with the appropriate month number (1-12)
          - Provide context about typical weather patterns and how they might affect travel plans
          - If they ask about future dates, explain that we're showing last year's data as a reference
      5. Keep responses concise and informative
      6. Always respond in English`;

    const dynamicContext = `Current Trip Details for ${currentDetails.destination}:
      - Dates: ${currentDetails.startDate} to ${currentDetails.endDate}
      - Budget: ${currentDetails.budget}
      - Preferences: ${currentDetails.preferences?.join(', ')}
      - PDF Export Language: ${currentDetails.language}`;

    console.log('[chat] Processing request:', {
      messageCount: messages.length,
      destination: currentDetails.destination
    });

    const result = await streamText({
      model: openai('gpt-4'),
      messages: [
        { role: 'system', content: staticSystemPrompt },
        { role: 'system', content: dynamicContext },
        ...messages
      ],
      maxTokens: 2000,
      temperature: 0.7,
      tools,
    });

    return result.toDataStreamResponse();
  } catch (error) {
    console.error('[chat] Error:', error);
    return new Response(
      JSON.stringify({ 
        error: 'Internal server error', 
        details: error instanceof Error ? error.message : 'Unknown error'
      }),
      { status: 500 }
    );
  }
}
