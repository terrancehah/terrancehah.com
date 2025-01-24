import React from 'react';
import { BudgetLevel, BUDGET_OPTIONS } from '../../managers/types';

export interface BudgetSelectorProps {
  currentBudget?: BudgetLevel;
  onUpdate?: (budget: BudgetLevel) => void;
}

export const BudgetSelector: React.FC<BudgetSelectorProps> = ({ currentBudget, onUpdate }) => {
  return (
    <div className="w-[80%] flex mx-auto max-w-[600px] bg-white rounded-3xl border border-gray-100 shadow-md">
      <div className="px-8 py-5">
        <h3 className="text-lg font-raleway font-semibold text-gray-700 mb-3">Budget Level</h3>
        <div className="grid grid-cols-2 gap-3">
          {BUDGET_OPTIONS.map(({ value, label, description }) => (
            <button
              key={value}
              onClick={() => onUpdate?.(value)}
              className={`
                px-4 py-3 rounded-lg font-raleway text-sm
                transition-all duration-200 ease-in-out
                ${currentBudget === value
                  ? 'bg-[#4798cc] bg-opacity-20 text-[#4798cc] shadow-sm'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                }
              `}
            >
              <div className="flex flex-col items-center gap-1">
                <span className="font-medium">{label}</span>
                <span className="text-lg font-medium">{value}</span>
                <span className="text-xs opacity-75 text-center">{description}</span>
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};
