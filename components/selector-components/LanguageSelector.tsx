import React from 'react';
import { SupportedLanguage, LANGUAGE_OPTIONS } from '../../managers/types';

export interface LanguageSelectorProps {
  currentLanguage?: SupportedLanguage;
  onUpdate?: (language: SupportedLanguage) => void;
}

export const LanguageSelector: React.FC<LanguageSelectorProps> = ({ currentLanguage, onUpdate }) => {
  return (
    <div className="w-[60%] max-w-[600px] mx-auto bg-white rounded-3xl shadow-md">
      <div className="px-8 py-5">
        <h3 className="text-lg font-raleway font-semibold text-gray-700 mb-3">Preferred Language</h3>
        <select
          value={currentLanguage}
          onChange={(e) => onUpdate?.(e.target.value as SupportedLanguage)}
          className="w-full p-2 border rounded font-raleway text-gray-700"
        >
          <option value="">Select a language</option>
          {LANGUAGE_OPTIONS.map(({ value, label }) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
};
