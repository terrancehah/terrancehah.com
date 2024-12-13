import React from 'react';
import { TravelPreference, PREFERENCE_OPTIONS } from '../../managers/types';

export interface PreferenceSelectorProps {
  currentPreferences?: TravelPreference[];
  onUpdate?: (preferences: TravelPreference[]) => void;
}

export const PreferenceSelector: React.FC<PreferenceSelectorProps> = ({ 
  currentPreferences = [], 
  onUpdate 
}) => {
  const [tempPreferences, setTempPreferences] = React.useState<TravelPreference[]>(() => {
    return currentPreferences || [];
  });

  // Update tempPreferences when currentPreferences changes
  React.useEffect(() => {
    console.log('Current preferences updated:', currentPreferences); // Debug log
    setTempPreferences(currentPreferences || []);
  }, [currentPreferences]);

  const handleConfirm = () => {
    onUpdate?.(tempPreferences);
  };

  const togglePreference = (preference: TravelPreference) => {
    setTempPreferences(prev => {
      if (prev.includes(preference)) {
        return prev.filter(p => p !== preference);
      } else {
        return [...prev, preference];
      }
    });
  };

  return (
    <div className="w-full max-w-[600px] bg-white rounded-3xl shadow-md">
      <div className="px-6 py-4">
        <h3 className="text-lg font-raleway font-semibold text-gray-700 mb-3">Travel Preferences</h3>
        <div className="grid grid-cols-2 gap-3 mb-4">
          {PREFERENCE_OPTIONS.map(option => (
            <div 
              key={option.value}
              onClick={() => togglePreference(option.value)}
              className={`
                cursor-pointer flex align-middle text-left p-3 rounded-lg font-raleway text-sm
                transition-all duration-200 ease-in-out
                ${tempPreferences.includes(option.value)
                  ? 'bg-[#4798cc] bg-opacity-20 text-[#4798cc] shadow-sm'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                }
              `}
            >
              <div className="flex items-center gap-2">
                <div className={`
                  min-w-4 h-4 rounded border flex items-center justify-center
                  ${tempPreferences.includes(option.value)
                    ? 'border-[#4798cc] bg-[#4798cc]'
                    : 'border-gray-300 bg-white'
                  }
                `}>
                  {tempPreferences.includes(option.value) && (
                    <svg className="w-3 h-3 text-white" viewBox="0 0 20 20" fill="currentColor">
                      <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                    </svg>
                  )}
                </div>
                <span>{option.icon}</span>
                <span>{option.label}</span>
              </div>
            </div>
          ))}
        </div>
        <div className="flex justify-end">
          <button
            onClick={handleConfirm}
            className="px-4 py-2 bg-[#4798cc] text-white rounded font-raleway text-sm hover:bg-[#3a7aa3] transition-colors duration-200"
          >
            Confirm
          </button>
        </div>
      </div>
    </div>
  );
};
