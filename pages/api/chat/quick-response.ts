import { openai } from '@ai-sdk/openai';
import { streamText, smoothStream } from 'ai';
import { NextRequest } from 'next/server';
import { SessionMetrics } from '../../../managers/types';
import { tools } from '../../../ai/tools';

interface QuickResponseBody {
  message: string;
  destination: string;
  messageCount: number;
  currentStage: number;
  metrics: SessionMetrics;
}

export const config = {
  runtime: 'edge'
};

export default async function handler(req: NextRequest) {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  try {
    const { messages, currentDetails, savedPlaces, currentStage, metrics } = await req.json();

    console.log('[quick-response] API received:', { 
      messageCount: messages?.length,
      lastMessage: {
        id: messages?.[messages.length - 1]?.id,
        role: messages?.[messages.length - 1]?.role,
        content: messages?.[messages.length - 1]?.content?.substring(0, 100) + '...',
      },
      currentStage,
      destination: currentDetails?.destination,
      hasMetrics: !!metrics
    });

    // // Add artificial delay for loading state to create a sense of AI generated responses
    // await new Promise(resolve => setTimeout(resolve, 2000));

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      console.log('[quick-response] No messages received');
      return new Response(
        JSON.stringify({ error: 'No messages provided' }),
        { status: 400 }
      );
    }

    // Only process complete messages (not streaming)
    const lastMessage = messages[messages.length - 1];
    if (!lastMessage?.content?.trim()) {
      console.log('[quick-response] Skipping incomplete message');
      return new Response(
        JSON.stringify({ error: 'Message not complete' }),
        { status: 400 }
      );
    }

    // Add artificial delay for loading state to create a sense of AI generated responses
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Validate request

    // console.log('[quick-response] Processing message:', {
    //   content: lastMessage.content,
    //   role: lastMessage.role,
    //   hasToolInvocations: !!lastMessage.toolInvocations,
    //   toolInvocations: lastMessage.toolInvocations?.map(t => ({
    //     name: t.toolName,
    //     state: t.state,
    //     hasResult: !!t.result
    //   }))
    // });

    // console.log('[quick-response] Processing message with context:', {
    //   destination: currentDetails?.destination,
    //   stage: currentStage,
    //   messageContent: lastMessage.content
    // });

    // Specialized system prompt focused on quick response generation
    const systemPrompt = `You are Quick-Rizz, a specialized quick response generator that works alongside Travel-Rizz.
    Your role is to assist Travel-Rizz by providing contextually relevant quick response options to users.

    CRITICAL INSTRUCTIONS:
    1. You are a SECONDARY AI that supports Travel-Rizz (the main AI). 
    Your job is to study the messages from Travel-Rizz and provide quick response options that help users interact with Travel-Rizz more effectively.

    2. There are 5 stages in the conversation:
      - INITIAL PARAMETER CHECK (Stage 1)
      - CITY INTRODUCTION (Stage 2)
      - PLACES BROWSING AND INTRODUCTION (Stage 3)
      - ITINERARY REVIEW (Stage 4)
      - FINAL CONFIRMATION (Stage 5)
    You MUST ALWAYS trigger the quickResponse tool to generate quick response options, no exceptions.

    3. ALWAYS provide exactly 3 contextually relevant options that:
      - Help users respond to Travel-Rizz's questions
      - Provide natural follow-up actions to Travel-Rizz's responses
      - Keep the conversation flowing towards the next stage when appropriate

    4. STAGE ADVANCEMENT DETECTION:
      Provide stage advancement options when Travel-Rizz:
      - Explicitly suggests moving to the next stage
      - Lists current parameters and asks if user wants to proceed
      - Asks if user wants to update anything or continue
      - Shows a summary and waits for confirmation
      - Uses phrases like:
        - "Let me know if you want to proceed"
        - "Let me know if these need to be updated"
        - "Would you like to continue"
        - "Shall we move on"
        - "Are you ready to"

    5. If Travel-Rizz asks an open-ended question, provide options that represent common or helpful responses.

    EXAMPLES:
    Example 1:
    User: "I need to adjust my travel dates"
    Assistant: Sure what do you need to adjust?
    You: quickResponse({ responses: ["Update my travel dates", "Modify my budget", "Change my preferences"] })

    Example 2:
    User: "I want to see more places"
    Assistant: Sure, what kind of places do you want to see?
    You: quickResponse({ responses: ["Show me some museums", "Find me local restaurants", "Continue to itinerary review"] })
    
    STAGE-SPECIFIC GUIDELINES:

    You have to check which stage the conversation is in and provide quick response options that are relevant to that stage.

    Stage 1 (Initial Parameters Check):
      - Only if Travel-Rizz suggesting stage advancement: Use suitable stage transition options
      - Otherwise: Focus on parameter update options
      - When Travel-Rizz asks which parameters to update or modify, provide options related to updating parameter
      - Only provide options related to yes, no, and parameter updates
      - Available options are examples like "Update my travel dates", "Modify my budget", "Change my preferences", "Update my language", 
      "No, I need to modify something", "Let me review the details", "Yes, let's proceed", "Yes, let's move on"

    Stage 2 (City Introduction):
      - Only if Travel-Rizz suggesting stage advancement: Use suitable stage transition options
      - Otherwise: Focus on city information options 
      - Only provide options related to yes, no, currency, local customs, weather, culture and local tips
      - Never provide options related to introducing or finding places
      - Available options are examples like "Tell me about the weather", "What's the currency conversion rate?", "Local customs and tips", "Tell me about the culture", 
      "No, I want to know more about the city", "Tell me more about the destination", "Yes, let's proceed to places introduction", "Yes, let's move on"

    Stage 3 (Places Browsing and Introduction):
      - Only if Travel-Rizz suggesting stage advancement: Use suitable stage transition options
      - Otherwise: Focus on place discovery options
      - Only provide options related to yes, no, and place discovery
      - Provide options that prompts AI to introduce places related to preferences
      - Never provide options related to saving or adding places (e.g., "Save Louvre Museum", "Add Changi Airport")
      - Never provide options related to wanting to know more of a single specific place
      - Available options are examples like "Show me museums", "Find me some restaurants", "Popular landmarks", "Add some cafes", "Explore some famous attractions",
      "No, I want to see more places", "Show me national parks", "Find me some theaters", "Popular eateries", "Explore some famous tourist spots",
      "No, I want to add more places", "Continue to itinerary review", "Yes, let's proceed", "Yes, let's move on", "View pricing"

    Stage 4 (Itinerary Review):
      - Only if Travel-Rizz suggesting stage advancement: Use suitable stage transition options
      - Otherwise: Focus on itinerary refinement options 
      - Available options are examples like "Add more activities", "Adjust the schedule", "Review the plan", "No, I want to review the plan", "No, I want to change my itinerary", "Yes, let's proceed", "Yes, let's move on"

    Stage 5 (Final Confirmation):
      - Focus on final preparations options ("Download itinerary", "Share with friends", "Make a copy")
      
    IMPORTANT: Carefully analyze Travel-Rizz's last message. 
    You should also study the conversation history to avoid repeating the same options.
    `;

    const dynamicContext = `Current Context for Quick Response Generation:
    - Destination: ${currentDetails?.destination || 'Not set'}
    - Current Stage: ${currentStage || 1}
    - Dates: ${currentDetails?.startDate || 'Not set'} to ${currentDetails?.endDate || 'Not set'}
    - Budget: ${currentDetails?.budget || 'Not set'}
    - Preferences: ${currentDetails?.preferences?.join(', ') || 'Not set'}
    - Saved Places Count: ${savedPlaces?.length || 0}
    - Payment Status: ${metrics?.isPaid ? 'Paid' : 'Not Paid'}

    STRICT STAGE ENFORCEMENT:
    Current Stage: ${currentStage || 1}
    Stage Rules:
    ${currentStage === 1 ? '- ONLY provide parameter update and stage advancement options' :
      currentStage === 2 ? '- ONLY provide city information and stage advancement options. NO place exploration options allowed.' :
      currentStage === 3 ? '- ONLY provide place discovery and stage advancement options' :
      currentStage === 4 ? '- ONLY provide itinerary refinement and stage advancement options' :
      '- ONLY provide final preparation options'}

    Last Travel-Rizz Message Analysis:
    ${messages[messages.length - 1]?.content || ''}
    
    Key Indicators to Check:
    1. Does it ask about proceeding? ${messages[messages.length - 1]?.content?.toLowerCase().includes('proceed') ? 'YES' : 'NO'}
    2. Does it suggest moving to the next stage? ${messages[messages.length - 1]?.content?.toLowerCase().includes('move on') ? 'YES' : 'NO'}
    3. Is message about place exploration? ${messages[messages.length - 1]?.content?.toLowerCase().includes('place') || messages[messages.length - 1]?.content?.toLowerCase().includes('attraction') ? 'YES' : 'NO'}

    IMPORTANT: Due to current stage (${currentStage || 1}), ${
      currentStage === 1 ? 'only parameter updates and stage advancement are allowed' :
      currentStage === 2 ? 'place exploration options are NOT allowed' :
      currentStage === 3 ? 'only place discovery and stage advancement are allowed' :
      currentStage === 4 ? 'only itinerary refinement and stage advancement are allowed' :
      'only final preparation options are allowed'
    }

    If ANY of these indicators are YES, consider providing stage advancement options.`;

    const result = await streamText({
      // model: openai('gpt-4o'),
      model: openai('gpt-4o-mini'),
      messages: [
        { role: 'system' as const, content: systemPrompt },
        { role: 'system' as const, content: dynamicContext },
        ...messages.map((m: { role: string; content: string }) => ({
          ...m,
          role: m.role === 'user' ? ('user' as const) : ('assistant' as const)
        }))
      ],
      temperature: 0.5,
      maxTokens: 200,
      tools: {
        quickResponse: tools.quickResponse,
      },
      toolChoice: { type: 'tool', toolName: 'quickResponse' },
      maxSteps: 1  // Ensure quick response is generated immediately
    });

    // console.log('[quick-response] Stream created, sending response');
    return result.toDataStreamResponse();
  } catch (error) {
    console.error('[quick-response] Error:', error);
    return new Response(
      JSON.stringify({ 
        error: 'Internal server error', 
        details: error instanceof Error ? error.message : 'Unknown error'
      }),
      { status: 500 }
    );
  }
}
