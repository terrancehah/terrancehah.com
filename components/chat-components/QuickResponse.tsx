'use client';

import React from 'react';

interface QuickResponseProps {
    responses: string[];
    onResponseSelect: (text: string) => void;
    isLoading?: boolean;
}

export const QuickResponse: React.FC<QuickResponseProps> = ({
    responses,
    onResponseSelect,
    isLoading = false
}) => {
    // console.log('[QuickResponse] Render:', { responses, isLoading });

    if (isLoading) {
        return (
            <div className="flex flex-wrap gap-2 my-1 justify-start">
                {[1, 2, 3].map((key) => (
                    <div 
                        key={key}
                        className="relative overflow-hidden min-w-[200px] 
                            before:absolute before:inset-0 before:z-0 before:bg-gradient-to-r 
                            before:from-blue-400 before:via-purple-400 before:to-pink-300 before: to-orange-400
                            before:animate-gradient-x before:bg-[length:200%_100%] after:absolute after:inset-0 
                            after:bg-white after:opacity-70 after:z-[1] shadow-sm
                            rounded-2xl px-3 py-1.5"
                    >
                        &nbsp;
                    </div>
                ))}
            </div>
        );
    }
    
    if (!Array.isArray(responses) || responses.length === 0) {
        console.log('[QuickResponse] No responses to render');
        return null;
    }
    
    return (
        <div className="flex flex-wrap gap-2 my-1 justify-start">
            {responses.map((text, index) => (
                <button
                    key={index}
                    onClick={() => onResponseSelect(text)}
                    className="min-w-fit max-w-[200px] px-3 py-1.5 text-sm text-gray-600 hover:text-gray-900 
                            bg-light-blue hover:bg-blue-200 hover:shadow-sm rounded-2xl transition-colors 
                            whitespace-nowrap overflow-hidden text-ellipsis"
                >
                    {text}
                </button>
            ))}
        </div>
    );
};