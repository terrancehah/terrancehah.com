import { Place } from '../utils/places-utils';
import { TravelDetails } from './types';
import { DatePickerProps } from '../components/travel-ui/selector-components/DateSelector';
import { PreferenceSelectorProps } from '../components/travel-ui/selector-components/PreferenceSelector';
import { BudgetSelectorProps } from '../components/travel-ui/selector-components/BudgetSelector';
import { LanguageSelectorProps } from '../components/travel-ui/selector-components/LanguageSelector';

export type ComponentType =
    | 'datePicker'
    | 'preferenceSelector'
    | 'budgetSelector'
    | 'languageSelector'
    | 'transportSelector'
    | 'placeCard'
    | 'carousel'
    | 'detailsCard';

export interface ComponentProps {
    datePicker: DatePickerProps;
    preferenceSelector: PreferenceSelectorProps;
    budgetSelector: BudgetSelectorProps;
    languageSelector: LanguageSelectorProps;
    transportSelector: {
        selectedMethod?: string;
        onMethodSelect?: (method: string) => void;
    };
    placeCard: {
        place: Place;
        onSelect?: (place: Place) => void;
        isSelected?: boolean;
    };
    carousel: {
        places: Place[];
        onPlaceSelect?: (place: Place) => void;
    };
    detailsCard: {
        content: {
            title?: string;
            details: Partial<TravelDetails>;
        };
    };
}

export interface ComponentRegistration<T extends ComponentType> {
    component: React.ComponentType<ComponentProps[T]>;
    defaultProps?: Partial<ComponentProps[T]>;
}

export interface ComponentState {
    id: string;
    type: ComponentType;
    props: any;
    isVisible: boolean;
    order: number;
}

export interface ComponentTransition {
    from?: ComponentType;
    to: ComponentType;
    animation?: string;
    duration?: number;
}

export interface ComponentUpdate {
    id: string;
    props?: any;
    isVisible?: boolean;
    order?: number;
}
