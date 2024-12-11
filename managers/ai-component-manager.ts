import { EventEmitter } from 'events';
import React from 'react';
import { DatePicker } from '../components/travel-ui/selector-components/DateSelector';
import { PreferenceSelector } from '../components/travel-ui/selector-components/PreferenceSelector';
import { BudgetSelector } from '../components/travel-ui/selector-components/BudgetSelector';
import { LanguageSelector } from '../components/travel-ui/selector-components/LanguageSelector';
import { PlaceCard } from '../components/travel-ui/place-components/PlaceCard';
import { TransportSelector } from '../components/travel-ui/transport-components/TransportSelector';
import Carousel from '../components/travel-ui/place-components/PlaceCarousel';
import DetailsCard from '../components/travel-ui/DetailsCard';
import { 
    ComponentType,
    ComponentProps,
    ComponentRegistration,
    ToolResponse,
    BudgetLevel,
    TravelPreference,
    SupportedLanguage,
    BUDGET_DESCRIPTIONS,
    PREFERENCE_ICONS,
    LANGUAGE_LABELS,
    ComponentState,
    ComponentTransition,
    ComponentUpdate
} from './types';

export class AIComponentManager extends EventEmitter {
    private componentRegistry: Map<ComponentType, ComponentRegistration<any>>;
    private activeComponents: Set<string>;
    private componentStates: Map<string, ComponentState>;

    constructor() {
        super();
        this.componentRegistry = this.initializeRegistry();
        this.activeComponents = new Set();
        this.componentStates = new Map();
    }

    public registerComponent<T extends ComponentType>(
        type: T,
        component: React.ComponentType<ComponentProps[T]>,
        defaultProps?: Partial<ComponentProps[T]>
    ): void {
        this.componentRegistry.set(type, {
            component,
            defaultProps
        });
    }

    public deregisterComponent(type: ComponentType): void {
        this.componentRegistry.delete(type);
        // Cleanup any active instances of this component type
        for (const [id, state] of this.componentStates.entries()) {
            if (state.type === type) {
                this.removeComponent(id);
            }
        }
    }

    public removeComponent(id: string): void {
        this.activeComponents.delete(id);
        this.componentStates.delete(id);
        this.emit('componentRemoved', id);
    }

    public handleToolResponse<T extends ComponentType>(response: ToolResponse<T>): void {
        try {
            const registration = this.componentRegistry.get(response.type);
            if (!registration) {
                throw new Error(`Component type ${response.type} not registered`);
            }

            const id = this.generateComponentId(response.type);
            const state: ComponentState = {
                id,
                type: response.type,
                props: {
                    ...registration.defaultProps,
                    ...response.props
                },
                isVisible: true,
                order: this.componentStates.size
            };

            this.componentStates.set(id, state);
            this.activeComponents.add(id);
            this.emit('componentAdded', state);

        } catch (error) {
            console.error('Error handling tool response:', error);
            this.emit('error', error);
        }
    }

    private generateComponentId(type: ComponentType): string {
        const timestamp = Date.now();
        const random = Math.floor(Math.random() * 1000);
        return `${type}-${timestamp}-${random}`;
    }

    public getActiveComponents(): ComponentState[] {
        return Array.from(this.activeComponents)
            .map(id => this.componentStates.get(id)!)
            .filter(state => state.isVisible)
            .sort((a, b) => a.order - b.order);
    }

    public updateComponent(update: ComponentUpdate): void {
        const state = this.componentStates.get(update.id);
        if (!state) {
            console.warn(`No component found with id ${update.id}`);
            return;
        }

        Object.assign(state, update.updates);
        this.emit('componentUpdated', state);
    }

    public transitionComponent(transition: ComponentTransition): void {
        const state = this.componentStates.get(transition.id);
        if (!state) {
            console.warn(`No component found with id ${transition.id}`);
            return;
        }

        // Apply the transition
        Object.assign(state, transition.to);
        this.emit('componentTransitioned', {
            id: transition.id,
            from: transition.from,
            to: transition.to,
            duration: transition.duration
        });
    }

    public destroy(): void {
        this.removeAllListeners();
        this.activeComponents.clear();
        this.componentStates.clear();
        this.componentRegistry.clear();
    }

    private initializeRegistry(): Map<ComponentType, ComponentRegistration<any>> {
        const registry = new Map();

        registry.set(ComponentType.DatePicker, {
            component: DatePicker,
            defaultProps: {
                startDate: undefined,
                endDate: undefined,
                onDateChange: () => {}
            }
        });

        registry.set(ComponentType.PreferenceSelector, {
            component: PreferenceSelector,
            defaultProps: {
                selectedPreferences: [],
                onPreferenceChange: () => {}
            }
        });

        registry.set(ComponentType.BudgetSelector, {
            component: BudgetSelector,
            defaultProps: {
                selectedBudget: undefined,
                onBudgetChange: () => {}
            }
        });

        registry.set(ComponentType.LanguageSelector, {
            component: LanguageSelector,
            defaultProps: {
                selectedLanguage: undefined,
                onLanguageChange: () => {}
            }
        });

        registry.set(ComponentType.PlaceCard, {
            component: PlaceCard,
            defaultProps: {
                title: '',
                description: '',
                imageUrl: '',
                onClick: () => {}
            }
        });

        registry.set(ComponentType.TransportSelector, {
            component: TransportSelector,
            defaultProps: {
                options: [],
                onSelect: () => {}
            }
        });

        registry.set(ComponentType.Carousel, {
            component: Carousel,
            defaultProps: {
                items: []
            }
        });

        registry.set(ComponentType.DetailsCard, {
            component: DetailsCard,
            defaultProps: {
                title: '',
                content: null
            }
        });

        return registry;
    }

    public hasComponent(type: ComponentType): boolean {
        return this.componentRegistry.has(type);
    }

    renderComponent<T extends ComponentType>(
        type: T,
        props: Partial<ComponentProps[T]>
    ): JSX.Element {
        const registration = this.componentRegistry.get(type);
        if (!registration) {
            throw new Error(`Component type "${type}" not registered`);
        }

        const { component: Component, defaultProps } = registration;
        const mergedProps = {
            ...defaultProps,
            ...props
        };

        return React.createElement(Component, {
            key: `${type}-${Date.now()}`,
            ...mergedProps
        });
    }

    getRegisteredComponents(): ComponentType[] {
        return Array.from(this.componentRegistry.keys());
    }
}
