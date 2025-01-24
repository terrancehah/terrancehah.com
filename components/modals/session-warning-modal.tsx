import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '../ui/dialog';
import { Button } from '../ui/button';
import { updateLastActive, handleSessionExpiry } from '@/utils/session-manager';

interface SessionWarningModalProps {
    isOpen: boolean;
    onClose: () => void;
    }
    
    export default function SessionWarningModal({ isOpen, onClose }: SessionWarningModalProps) {
        const handleExtendSession = () => {
        updateLastActive();
        onClose();
        };
    
        return (
        <Dialog open={isOpen} onOpenChange={onClose}>
            <DialogContent className="sm:max-w-[425px] z-[100]">
            <DialogHeader>
                <DialogTitle>Session Expiring Soon</DialogTitle>
                <DialogDescription>
                Your session will expire in 5 minutes due to inactivity. Would you like to continue?
                </DialogDescription>
            </DialogHeader>
            <DialogFooter>
                <Button variant="outline" onClick={handleSessionExpiry} className="w-full sm:w-auto">
                End Session
                </Button>
                <Button onClick={handleExtendSession} className="w-full sm:w-auto">
                Continue Session
                </Button>
            </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}