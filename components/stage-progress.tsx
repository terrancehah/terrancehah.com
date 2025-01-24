'use client';

import React, { useState } from 'react';
import { cn } from '../lib/utils';
import { CheckIcon, LockClosedIcon } from '@heroicons/react/24/outline';
import { Info } from 'lucide-react';
import PaymentSuccessPopup from './modals/payment-success-popup';

interface StageProgressProps {
    currentStage: number;
    isPaid: boolean;
}

const stages = [
    { id: 1, title: "Initial Parameters" },
    { id: 2, title: "City Introduction" },
    { id: 3, title: "Places Introduction" },
    { id: 4, title: "Itinerary Review" },
    { id: 5, title: "Confirmation" }
];

export interface StepsRootProps extends React.HTMLAttributes<HTMLDivElement> {
    orientation?: 'horizontal' | 'vertical';
    colorPalette?: 'gray' | 'blue';
    variant?: 'subtle' | 'solid';
    size?: 'sm' | 'md' | 'lg';
}

export const StepsRoot = React.forwardRef<HTMLDivElement, StepsRootProps>(
    ({ className, orientation = 'horizontal', colorPalette = 'blue', variant = 'solid', size = 'md', ...props }, ref) => (
        <div
            ref={ref}
            className={cn(
                'w-full bg-white border-b border-gray-200',
                orientation === 'vertical' ? 'flex-col' : 'flex',
                className
            )}
            {...props}
        />
    )
);
StepsRoot.displayName = 'StepsRoot';

export interface StepsListProps extends React.HTMLAttributes<HTMLDivElement> {}

export const StepsList = React.forwardRef<HTMLDivElement, StepsListProps>(
    ({ className, ...props }, ref) => (
        <div
            ref={ref}
            className={cn(
                'max-w-screen-2xl mx-auto px-4 py-3',
                className
            )}
            {...props}
        >
            <div className="flex items-center justify-between w-full">
                {props.children}
            </div>
        </div>
    )
);
StepsList.displayName = 'StepsList';

export interface StepsItemProps extends React.HTMLAttributes<HTMLDivElement> {
    step: number;
    currentStep: number;
    title: string;
    description?: string;
    isLocked?: boolean;
    isLast?: boolean;
}

export const StepsItem = React.forwardRef<HTMLDivElement, StepsItemProps>(
    ({ className, step, currentStep, title, description, isLocked, isLast, ...props }, ref) => (
        <>
            <div className="flex flex-col items-center relative" ref={ref} {...props}>
                <div 
                    className={cn(
                        'w-8 h-8 rounded-full flex items-center justify-center transition-colors',
                        currentStep > step ? 'bg-green-500' : 
                        currentStep === step ? 'bg-blue-500' : 
                        'bg-gray-200',
                        isLocked ? 'cursor-not-allowed' : '',
                        className
                    )}
                >
                    {currentStep > step ? (
                        <CheckIcon className="w-5 h-5 text-white" />
                    ) : (
                        <span className={cn(
                            'text-sm',
                            currentStep === step ? 'text-white' : 'text-gray-600'
                        )}>
                            {step}
                        </span>
                    )}
                </div>
                <div className="flex flex-col items-center mt-1">
                    <span className="text-sm font-medium">{title}</span>
                    {description && (
                        <span className="text-xs text-gray-500">{description}</span>
                    )}
                </div>
                {isLocked && (
                    <span className="absolute right-1">
                        <LockClosedIcon className="w-4 h-4 text-gray-500" />
                    </span>
                )}
            </div>
            {!isLast && (
                <div className="flex-1 flex h-[2px] my-auto bg-gray-400 mx-6">
                    <div className="w-[100%] h-[2px] bg-gray-400"/>
                </div>
            )}
        </>
    )
);
StepsItem.displayName = 'StepsItem';

const StageProgress: React.FC<StageProgressProps> = ({ currentStage, isPaid }) => {
    const [showPopup, setShowPopup] = useState(false);

    return (
        <StepsRoot>
            <StepsList>
                {stages.map((stage, index) => (
                    <StepsItem
                        key={stage.id}
                        step={stage.id}
                        currentStep={currentStage}
                        title={stage.title}
                        isLocked={currentStage <= 3 && (stage.id === 4 || stage.id === 5)}
                        isLast={index === stages.length - 1}
                    />
                ))}
                {currentStage > 3 && (
                    <button 
                        onClick={() => setShowPopup(true)}
                        className="ml-4 p-2 text-gray-500 hover:text-gray-700 absolute right-2"
                    >
                        <Info size={20} />
                    </button>
                )}
                <PaymentSuccessPopup 
                    isOpen={showPopup} 
                    onClose={() => setShowPopup(false)}
                    title="Travel-Rizz Features"
                    description="Here are a range of features to help you plan your trip effectively:"
                />
            </StepsList>
        </StepsRoot>
    );
};

export default StageProgress;