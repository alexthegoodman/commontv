import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import Mtk from "gi://Mtk";
import St from 'gi://St';
import Clutter from "gi://Clutter";
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import { ThemeManager } from './themes/theme-manager.js';

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
  private isLayoutInProgress = false;
  private themeManager?: ThemeManager;
  
  // Layout constants
  private readonly CARD_HEIGHT = 360; // 180 is rather thin, hard to see content
  private readonly CARD_WIDTH = 500;
  private readonly CARD_MARGIN = 10;
  private readonly MAIN_MARGIN = 20;
  
  private displayConnections: number[] = [];
  private windowManagerConnections: number[] = [];
  private keybindingIds: string[] = [];
  private focusTimeout: number | null = null;
  private statusButton?: PanelMenu.Button;
  private debugLogs: string[] = [];
  private readonly MAX_LOGS = 5;

  enable() {
    this.gsettings = this.getSettings();
    this.windowTracker = Shell.WindowTracker.get_default();
    this.display = global.display;
    
    this.logDebug('Extension enabled - Starting CommonTV debug logging');
    
    // Initialize theme manager
    this.themeManager = new ThemeManager(this.path, true);
    this.initializeTheme();
    
    this.connectSignals();
    this.setupKeybindings();
    this.createStatusIndicator();
    this.initializeLayout();
  }

  disable() {
    // Clean up focus timeout
    if (this.focusTimeout) {
      GLib.source_remove(this.focusTimeout);
      this.focusTimeout = null;
    }
    
    // Clean up theme manager
    if (this.themeManager) {
      this.themeManager.cleanup();
      this.themeManager = undefined;
    }
    
    this.disconnectSignals();
    this.removeKeybindings();
    this.removeStatusIndicator();
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
    this.displayConnections.push(
      this.display.connect('window-created', (_display: Meta.Display, window: Meta.Window) => {
        this.onWindowCreated(window);
      })
    );
    
    // Listen for window destruction
    this.windowManagerConnections.push(
      global.window_manager.connect('destroy', (_wm: Shell.WM, actor: Meta.WindowActor) => {
        const window = actor.get_meta_window();
        this.onWindowDestroyed(window!);
      })
    );
    
    // Listen for global focus changes
    this.displayConnections.push(
      this.display.connect('notify::focus-window', (_display: Meta.Display) => {
        this.onFocusChanged();
      })
    );
  }

  private disconnectSignals() {
    // Disconnect display signals
    this.displayConnections.forEach(id => {
      if (this.display) {
        this.display.disconnect(id);
      }
    });
    this.displayConnections = [];
    
    // Disconnect window manager signals
    this.windowManagerConnections.forEach(id => {
      global.window_manager.disconnect(id);
    });
    this.windowManagerConnections = [];
    
    // Disconnect all window-specific signals
    this.windowStates.forEach((state, windowId) => {
      this.disconnectWindowSignals(state.window);
    });
  }

  private initializeLayout() {
    this.redetermineLayout();
  }

  private redetermineLayout() {
    if (this.isLayoutInProgress) {
      this.logDebug(`redetermineLayout: Skipping - layout already in progress`);
      return;
    }
    
    this.isLayoutInProgress = true;
    this.logDebug(`redetermineLayout: Starting layout redetermination`);
    
    try {
      // Get current windows and organize them
      const windows = this.getAllUserWindows();
    if (windows.length > 0) {
      // Use currently focused window as main, or first window if none focused
      const focusedWindow = this.display?.get_focus_window();
      const mainWindow = (focusedWindow && windows.includes(focusedWindow)) ? focusedWindow : windows[0];
      
      this.setMainWindow(mainWindow);
      
      windows.forEach(window => {
        if (window !== mainWindow) {
          this.addCardWindow(window);          
        }
      });

      this.layoutCards(); // call just once now
    }
    } finally {
      this.isLayoutInProgress = false;
    }
  }

  private getAllUserWindows(): Meta.Window[] {
    if (!this.display) return [];
    
    const workspace = global.workspace_manager.get_active_workspace();
    return workspace.list_windows().filter(window => 
      window.get_window_type() === Meta.WindowType.NORMAL &&
      !window.is_skip_taskbar() &&
      !window.minimized
    );
  }

  private onWindowCreated(window: Meta.Window) {
    if (window.get_window_type() !== Meta.WindowType.NORMAL || window.is_skip_taskbar() || window.minimized) {
      return;
    }
    
    // Initialize window state tracking
    this.storeOriginalGeometry(window);
    
    // Ensure new window gets focus so focus handler calls redetermineLayout
    window.focus(global.get_current_time());
    
    this.updateStatusIndicator();
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
    
    this.updateStatusIndicator();
  }

  private onFocusChanged() {
    this.updateStatusIndicator();
    
    // Add a small delay to let focus settle and prevent conflicts
    if (this.focusTimeout) {
      GLib.source_remove(this.focusTimeout);
    }
    
    this.focusTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
      const focusedWindow = this.display?.get_focus_window();
      
      if (!focusedWindow || 
          focusedWindow.get_window_type() !== Meta.WindowType.NORMAL ||
          focusedWindow.is_skip_taskbar() ||
          focusedWindow.minimized ||
          focusedWindow === this.mainWindow) {
        this.focusTimeout = null;
        return GLib.SOURCE_REMOVE;
      }
      
      // Check if the focused window is a tracked window or a new one
      const windowId = focusedWindow.get_id();
      const isTrackedWindow = this.windowStates.has(windowId);
      
      if (isTrackedWindow) {
        // For existing tracked windows, maintain their current state
        // Don't automatically promote to main - let explicit actions handle promotion
        // return GLib.SOURCE_REMOVE;
      } else {
        // For new windows not yet tracked, run full layout initialization
        this.storeOriginalGeometry(focusedWindow);
      }

      this.redetermineLayout();
      
      this.focusTimeout = null;
      return GLib.SOURCE_REMOVE;
    });
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
    this.logDebug(`setMainWindow: Setting window ${window.get_id()} as main window`);
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
    this.logDebug(`addCardWindow: Adding window ${window.get_id()} as card window`);
    // if (window === this.mainWindow) return; // if this.addCardWindow(this.mainWindow); is called, we need to support it
    
    // this.removeFromCards(window);

    const index = this.cardWindows.indexOf(window);
    if (index > -1) {
      this.cardWindows.splice(index, 1);
      // this.layoutCards();
    }

    this.cardWindows.push(window);
    this.resizeToCard(window);
    // this.layoutCards();
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
    if (monitor == null) return;
    
    const workArea = global.workspace_manager.get_active_workspace().get_work_area_for_monitor(monitor);
    
    // Main view takes most of the screen, leaving space for cards at bottom
    const mainRect = new Mtk.Rectangle();
    mainRect.x = workArea.x + this.MAIN_MARGIN;
    mainRect.y = workArea.y + this.MAIN_MARGIN;
    mainRect.width = workArea.width - (this.MAIN_MARGIN * 2);
    mainRect.height = workArea.height - this.CARD_HEIGHT - (this.MAIN_MARGIN * 3);
    
    this.storeOriginalGeometry(window);
    
    this.logDebug(`resizeToMainView: About to resize window ${window.get_id()} to Main (${mainRect.width}x${mainRect.height} at ${mainRect.x},${mainRect.y})`);
    window.move_resize_frame(false, mainRect.x, mainRect.y, mainRect.width, mainRect.height);
    this.logDebug(`resizeToMainView: Completed move_resize_frame call for window ${window.get_id()}`);
    
    const windowId = window.get_id();
    const existingState = this.windowStates.get(windowId);
    if (existingState) {
      // Update state but preserve original geometry
      existingState.state = 'main';
    }
  }

  private resizeToCard(window: Meta.Window) {
    this.storeOriginalGeometry(window);
    
    const windowId = window.get_id();
    const existingState = this.windowStates.get(windowId);
    if (existingState) {
      // Update state but preserve original geometry
      existingState.state = 'card';
    }
    
    // Card positioning will be handled by layoutCards()
  }

  private layoutCards() {
    this.logDebug(`layoutCards: Starting layout of ${this.cardWindows.length} card windows`);
    const monitor = this.display?.get_current_monitor();
    if (monitor == null) {
      this.logDebug('layoutCards: No monitor found, exiting early');
      return;
    }

    this.logDebug('layoutCards: Monitor found, proceeding');
    
    const workArea = global.workspace_manager.get_active_workspace().get_work_area_for_monitor(monitor);
    const cardRowY = workArea.y + workArea.height - this.CARD_HEIGHT - this.MAIN_MARGIN;
    
    let currentX = workArea.x + this.CARD_MARGIN;
    
    this.logDebug('layoutCards: Workspace found, proceeding with layout');

    this.cardWindows.forEach((window, index) => {
      this.logDebug(`layoutCards: About to resize card window ${window.get_id()} (index ${index}) to (${this.CARD_WIDTH}x${this.CARD_HEIGHT} at ${currentX},${cardRowY})`);
      window.move_resize_frame(
        false,
        currentX,
        cardRowY,
        this.CARD_WIDTH,
        this.CARD_HEIGHT
      );
      this.logDebug(`layoutCards: Completed move_resize_frame for card window ${window.get_id()}`);
      
      currentX += this.CARD_WIDTH + this.CARD_MARGIN;
    });
    
    // Connect click handlers for all card windows after layout
    // This prevents duplicate connections during frequent layout calls
    // this.cardWindows.forEach(window => {
    //   this.connectCardClickHandler(window);
    // });
  }

  private connectCardClickHandler(window: Meta.Window) {
    // Check if this window already has click handlers to avoid duplicates
    const windowId = window.get_id();
    const state = this.windowStates.get(windowId);
    if (state && (state as any).hasClickHandlers) {
      return; // Already has handlers
    }
    
    // Only use button press events to avoid conflicts with global focus handler
    // Remove the redundant focus listener that conflicts with global focus handling
    const buttonPressId = window.connect('notify::appears-focused', () => {
      if (window.appears_focused && this.cardWindows.includes(window)) {
        this.setMainWindow(window);
      }
    });
    
    this.storeConnectionId(window, buttonPressId);
    
    // Mark that this window has click handlers
    if (state) {
      (state as any).hasClickHandlers = true;
    }
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
      (state as any).hasClickHandlers = false;
    }
  }

  private storeOriginalGeometry(window: Meta.Window) {
    const windowId = window.get_id();
    const existingState = this.windowStates.get(windowId);
    if (!existingState) {
      // Store original geometry only once, before any modifications
      const originalGeometry = window.get_frame_rect();
      this.windowStates.set(windowId, {
        window,
        originalGeometry,
        state: 'main'
      });
    }
  }

  private setupKeybindings() {
    // Add keybinding to convert focused window to card
    const cardKeybindingId = Main.wm.addKeybinding(
      'convert-to-card',
      this.gsettings!,
      Meta.KeyBindingFlags.NONE,
      Shell.ActionMode.NORMAL,
      () => {
        const focusedWindow = global.display.get_focus_window();
        if (focusedWindow && focusedWindow.get_window_type() === Meta.WindowType.NORMAL) {
          this.convertWindowToCard(focusedWindow);
        }
      }
    );
    this.keybindingIds.push('convert-to-card');
    
    // Add keybinding to convert focused window to main
    const mainKeybindingId = Main.wm.addKeybinding(
      'convert-to-main',
      this.gsettings!,
      Meta.KeyBindingFlags.NONE,
      Shell.ActionMode.NORMAL,
      () => {
        const focusedWindow = global.display.get_focus_window();
        if (focusedWindow && focusedWindow.get_window_type() === Meta.WindowType.NORMAL) {
          this.setMainWindow(focusedWindow);
        }
      }
    );
    this.keybindingIds.push('convert-to-main');
  }
  
  private removeKeybindings() {
    this.keybindingIds.forEach(id => {
      Main.wm.removeKeybinding(id);
    });
    this.keybindingIds = [];
  }
  
  private convertWindowToCard(window: Meta.Window) {
    this.addCardWindow(window);
    if (window === this.mainWindow) {
      // If converting main window to card, promote first card to main
      if (this.cardWindows.length > 0) {
        this.setMainWindow(this.cardWindows[0]);
      } else {
        this.mainWindow = undefined;
      }
    }
  }

  private restoreAllWindows() {
    this.logDebug(`restoreAllWindows: Starting restoration of ${this.windowStates.size} windows`);
    this.windowStates.forEach((state) => {
      const { window, originalGeometry } = state;
      this.logDebug(`restoreAllWindows: About to restore window ${window.get_id()} to original (${originalGeometry.width}x${originalGeometry.height} at ${originalGeometry.x},${originalGeometry.y})`);
      window.move_resize_frame(
        false,
        originalGeometry.x,
        originalGeometry.y,
        originalGeometry.width,
        originalGeometry.height
      );
      this.logDebug(`restoreAllWindows: Completed restoration for window ${window.get_id()}`);
    });
    // this.logDebug(`restoreAllWindows: Finished restoring all windows`);
  }

  private createStatusIndicator() {
    this.statusButton = new PanelMenu.Button(0.0, 'CommonTV', false);
    
    let label = this.themeManager?.createThemedLabel('CommonTV: Debug Ready', 'small');
    if (!label) {
      label = new St.Label({
        text: 'CommonTV: Debug Ready',
        style_class: 'panel-status-indicator-label',
        y_align: Clutter.ActorAlign.CENTER
      });
    }
    
    // Add theme-specific styling to the status indicator
    if (this.themeManager?.getCurrentTheme()?.name !== 'default') {
      label.add_style_class_name('commontv-panel-status');
    }
    
    this.statusButton.add_child(label);
    Main.panel.addToStatusArea('commontv-indicator', this.statusButton);
    this.updateStatusIndicator();
  }

  private updateStatusIndicator() {
    if (!this.statusButton) return;
    
    const label = this.statusButton.get_child_at_index(0) as St.Label;
    if (!label) return;
    
    label.set_text(this.formatDebugStatus());
  }

  private removeStatusIndicator() {
    if (this.statusButton) {
      this.statusButton.destroy();
      this.statusButton = undefined;
    }
  }

  private logDebug(message: string) {
    const timestamp = new Date().toLocaleTimeString();
    const logEntry = `[${timestamp}] ${message}`;
    
    this.debugLogs.push(logEntry);
    if (this.debugLogs.length > this.MAX_LOGS) {
      this.debugLogs = this.debugLogs.slice(-this.MAX_LOGS);
    }
    
    console.log(`CommonTV Debug: ${logEntry}`);
    this.updateStatusIndicator();
  }

  private formatDebugStatus(): string {
    if (this.debugLogs.length === 0) {
      return 'CommonTV: No debug logs';
    }
    
    const latestLog = this.debugLogs[this.debugLogs.length - 1];
    const logCount = this.debugLogs.length;
    return `CommonTV: [${logCount}] ${latestLog}`;
  }

  private initializeTheme() {
    if (!this.themeManager) return;
    
    // Get theme preference from settings, default to tv-futuristic
    const savedTheme = this.gsettings?.get_string('current-theme') || 'tv-futuristic';
    
    this.logDebug(`Initializing theme: ${savedTheme}`);
    
    const success = this.themeManager.applyTheme(savedTheme);
    if (!success) {
      this.logDebug('Failed to apply saved theme, falling back to default');
      this.themeManager.applyTheme('default');
    }
  }

  private getAvailableThemes() {
    return this.themeManager?.getAvailableThemes() || [];
  }

  private switchTheme(themeName: string) {
    if (!this.themeManager) return false;
    
    const success = this.themeManager.applyTheme(themeName);
    if (success) {
      this.gsettings?.set_string('current-theme', themeName);
      this.logDebug(`Switched to theme: ${themeName}`);
      this.updateStatusIndicator();
    }
    return success;
  }
}