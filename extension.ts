import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import Mtk from "gi://Mtk";
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

interface WindowState {
  window: Meta.Window;
  originalGeometry: Mtk.Rectangle;
  state: 'main' | 'card' | 'minimized';
}

export default class CommonTVExtension extends Extension {
  private gsettings?: Gio.Settings;
  private windowTracker?: Shell.WindowTracker;
  private display?: Meta.Display;
  private windowStates: Map<number, WindowState> = new Map();
  private mainWindow?: Meta.Window;
  private cardWindows: Meta.Window[] = [];
  
  // Layout constants
  private readonly CARD_HEIGHT = 180;
  private readonly CARD_WIDTH = 320;
  private readonly CARD_MARGIN = 10;
  private readonly MAIN_MARGIN = 20;
  
  private signalConnections: number[] = [];

  enable() {
    this.gsettings = this.getSettings();
    this.windowTracker = Shell.WindowTracker.get_default();
    this.display = global.display;
    
    this.connectSignals();
    this.initializeLayout();
  }

  disable() {
    this.disconnectSignals();
    this.restoreAllWindows();
    this.gsettings = undefined;
    this.windowTracker = undefined;
    this.display = undefined;
    this.windowStates.clear();
    this.mainWindow = undefined;
    this.cardWindows = [];
  }

  private connectSignals() {
    if (!this.display) return;
    
    // Listen for new windows
    this.signalConnections.push(
      this.display.connect('window-created', (_display: Meta.Display, window: Meta.Window) => {
        this.onWindowCreated(window);
      })
    );
    
    // Listen for window state changes
    this.signalConnections.push(
      global.window_manager.connect('minimize', (_wm: Shell.WM, actor: Meta.WindowActor) => {
        const window = actor.get_meta_window();
        this.onWindowMinimized(window!);
      })
    );
    
    this.signalConnections.push(
      global.window_manager.connect('unminimize', (_wm: Shell.WM, actor: Meta.WindowActor) => {
        const window = actor.get_meta_window();
        this.onWindowUnminimized(window!);
      })
    );
    
    // Listen for window destruction
    this.signalConnections.push(
      global.window_manager.connect('destroy', (_wm: Shell.WM, actor: Meta.WindowActor) => {
        const window = actor.get_meta_window();
        this.onWindowDestroyed(window!);
      })
    );
  }

  private disconnectSignals() {
    // Disconnect global signals
    this.signalConnections.forEach(id => {
      if (this.display) {
        this.display.disconnect(id);
      }
    });
    this.signalConnections = [];
    
    // Disconnect all window-specific signals
    this.windowStates.forEach((state, windowId) => {
      this.disconnectWindowSignals(state.window);
    });
  }

  private initializeLayout() {
    // Get current windows and organize them
    const windows = this.getAllUserWindows();
    if (windows.length > 0) {
      this.setMainWindow(windows[0]);
      for (let i = 1; i < windows.length; i++) {
        this.addCardWindow(windows[i]);
      }
    }
  }

  private getAllUserWindows(): Meta.Window[] {
    if (!this.display) return [];
    
    const workspace = global.workspace_manager.get_active_workspace();
    return workspace.list_windows().filter(window => 
      window.get_window_type() === Meta.WindowType.NORMAL &&
      !window.is_skip_taskbar()
    );
  }

  private onWindowCreated(window: Meta.Window) {
    if (window.get_window_type() !== Meta.WindowType.NORMAL || window.is_skip_taskbar()) {
      return;
    }
    
    // Add new windows as cards by default
    this.addCardWindow(window);
  }

  private onWindowMinimized(window: Meta.Window) {
    // Override minimize behavior - convert to card instead
    window.unminimize();
    this.addCardWindow(window);
  }

  private onWindowUnminimized(window: Meta.Window) {
    // Handle unminimize if needed
  }

  private onWindowDestroyed(window: Meta.Window) {
    const windowId = window.get_id();
    
    // Clean up window state
    this.disconnectWindowSignals(window);
    this.windowStates.delete(windowId);
    
    // Remove from main window if it was the main window
    if (this.mainWindow === window) {
      this.mainWindow = undefined;
      // Promote first card to main if available
      if (this.cardWindows.length > 0) {
        this.setMainWindow(this.cardWindows[0]);
      }
    }
    
    // Remove from cards
    this.removeFromCards(window);
  }

  // Utility method to cycle to next card window
  private cycleToNextMainWindow() {
    if (this.cardWindows.length === 0) return;
    
    let nextIndex = 0;
    if (this.mainWindow) {
      // Find next card after current main window
      const currentMainInCards = this.cardWindows.findIndex(w => w === this.mainWindow);
      if (currentMainInCards !== -1) {
        nextIndex = (currentMainInCards + 1) % this.cardWindows.length;
      }
    }
    
    this.setMainWindow(this.cardWindows[nextIndex]);
  }

  // Utility method to cycle to previous card window  
  private cycleToPrevMainWindow() {
    if (this.cardWindows.length === 0) return;
    
    let prevIndex = this.cardWindows.length - 1;
    if (this.mainWindow) {
      const currentMainInCards = this.cardWindows.findIndex(w => w === this.mainWindow);
      if (currentMainInCards !== -1) {
        prevIndex = currentMainInCards === 0 ? this.cardWindows.length - 1 : currentMainInCards - 1;
      }
    }
    
    this.setMainWindow(this.cardWindows[prevIndex]);
  }

  private setMainWindow(window: Meta.Window) {
    if (this.mainWindow === window) return;
    
    // Store current main window as card if exists
    if (this.mainWindow) {
      this.addCardWindow(this.mainWindow);
    }
    
    this.mainWindow = window;
    this.removeFromCards(window);
    this.resizeToMainView(window);
  }

  private addCardWindow(window: Meta.Window) {
    if (window === this.mainWindow) return;
    
    this.removeFromCards(window);
    this.cardWindows.push(window);
    this.resizeToCard(window);
    this.layoutCards();
  }

  private removeFromCards(window: Meta.Window) {
    const index = this.cardWindows.indexOf(window);
    if (index > -1) {
      this.cardWindows.splice(index, 1);
      this.layoutCards();
    }
  }

  private resizeToMainView(window: Meta.Window) {
    const monitor = this.display?.get_current_monitor();
    if (!monitor) return;
    
    const workArea = global.workspace_manager.get_active_workspace().get_work_area_for_monitor(monitor);
    
    // Main view takes most of the screen, leaving space for cards at bottom
    const mainRect = new Mtk.Rectangle();
    mainRect.x = workArea.x + this.MAIN_MARGIN;
    mainRect.y = workArea.y + this.MAIN_MARGIN;
    mainRect.width = workArea.width - (this.MAIN_MARGIN * 2);
    mainRect.height = workArea.height - this.CARD_HEIGHT - (this.MAIN_MARGIN * 3);
    
    this.storeOriginalGeometry(window);
    window.move_resize_frame(false, mainRect.x, mainRect.y, mainRect.width, mainRect.height);
    
    const state: WindowState = {
      window,
      originalGeometry: window.get_frame_rect(),
      state: 'main'
    };
    this.windowStates.set(window.get_id(), state);
  }

  private resizeToCard(window: Meta.Window) {
    this.storeOriginalGeometry(window);
    
    const state: WindowState = {
      window,
      originalGeometry: window.get_frame_rect(),
      state: 'card'
    };
    this.windowStates.set(window.get_id(), state);
    
    // Card positioning will be handled by layoutCards()
  }

  private layoutCards() {
    const monitor = this.display?.get_current_monitor();
    if (!monitor) return;
    
    const workArea = global.workspace_manager.get_active_workspace().get_work_area_for_monitor(monitor);
    const cardRowY = workArea.y + workArea.height - this.CARD_HEIGHT - this.MAIN_MARGIN;
    
    let currentX = workArea.x + this.CARD_MARGIN;
    
    this.cardWindows.forEach((window, index) => {
      window.move_resize_frame(
        false,
        currentX,
        cardRowY,
        this.CARD_WIDTH,
        this.CARD_HEIGHT
      );
      
      currentX += this.CARD_WIDTH + this.CARD_MARGIN;
      
      // Connect click handler to promote card to main view
      this.connectCardClickHandler(window);
    });
  }

  private connectCardClickHandler(window: Meta.Window) {
    // Connect multiple interaction methods for promoting cards to main view
    
    // Focus-based promotion (when user clicks/focuses the card window)
    const focusId = window.connect('focus', () => {
      if (this.cardWindows.includes(window)) {
        this.setMainWindow(window);
      }
    });
    
    // Store the connection ID to clean up later
    this.storeConnectionId(window, focusId);
    
    // Also handle button press events for more direct interaction
    const buttonPressId = window.connect('notify::appears-focused', () => {
      if (window.appears_focused && this.cardWindows.includes(window)) {
        this.setMainWindow(window);
      }
    });
    
    this.storeConnectionId(window, buttonPressId);
  }

  private storeConnectionId(window: Meta.Window, connectionId: number) {
    const windowId = window.get_id();
    const state = this.windowStates.get(windowId);
    if (state) {
      if (!(state as any).connectionIds) {
        (state as any).connectionIds = [];
      }
      (state as any).connectionIds.push(connectionId);
    }
  }

  private disconnectWindowSignals(window: Meta.Window) {
    const windowId = window.get_id();
    const state = this.windowStates.get(windowId);
    if (state && (state as any).connectionIds) {
      (state as any).connectionIds.forEach((id: number) => {
        window.disconnect(id);
      });
      (state as any).connectionIds = [];
    }
  }

  private storeOriginalGeometry(window: Meta.Window) {
    const state = this.windowStates.get(window.get_id());
    if (!state) {
      // Store original geometry if not already stored
      const originalGeometry = window.get_frame_rect();
      this.windowStates.set(window.get_id(), {
        window,
        originalGeometry,
        state: 'main'
      });
    }
  }

  private restoreAllWindows() {
    this.windowStates.forEach((state) => {
      const { window, originalGeometry } = state;
      window.move_resize_frame(
        false,
        originalGeometry.x,
        originalGeometry.y,
        originalGeometry.width,
        originalGeometry.height
      );
    });
  }
}